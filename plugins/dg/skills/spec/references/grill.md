# Grill-me protocol pointer

`/spec` does not carry its own interview methodology. The protocol is INLINED from
[`grill-me/references/protocol.md`](../../grill-me/references/protocol.md) and
followed in-context — the same way `/kick` Phase 1 does it. Read that file at each of plan.md's
four grill-me passes (steps 1, 1.5, 2, 6); do not summarize or reimplement it here.

**Fast mode runs ONE pass, not four.** `/spec --fast` collapses passes 1, 1.5, and 2 into a single
interview covering all three scopes, and has no pass 3 — see [fast.md](fast.md) F2. Everything
below about protocol, main-loop interviewing, and the decision log applies unchanged to that one
pass; only the pass count and the per-pass research personas differ.

## Four passes, four narrow scopes

Unlike its predecessor's single all-branches discovery interview, `/spec` runs the protocol **four
times**, each scoped to a narrow topic so no single pass tries to converge a full-feature design
tree on its own:

| Pass | Step | Research agent | Scope |
|---|---|---|---|
| 1 | plan.md step 1 | arch `[fable, xhigh]` | Architecture placement, integration points, risk areas, where the feature fits the existing system. |
| 1.5 | plan.md step 1.5 | dominant language agent `[sonnet, medium]` | **Code-surface contracts** — shared types/interfaces, module and file homes, cross-boundary data shapes, error/result conventions, reuse-vs-new. Recommendation + alternatives per question. Self-collapses when nothing is contested; skipped for single-slice bundles. See [templates/structure-grill.md](templates/structure-grill.md). |
| 2 | plan.md step 2 | foreman `[fable, xhigh]` | Work ordering — vertical slice boundaries, dependency graph, gaps the earlier passes' focus didn't cover (scope holes, missing acceptance criteria). |
| 3 | plan.md step 6 | foreman `[fable, xhigh]` | Gaps/vague items the per-slice review findings (step 5) surfaced — contradictions between slices, ambiguity the reviewers flagged. |

Each pass runs the protocol's interview rounds (self-serve research first, `AskUserQuestion` only
for what can't be answered from the codebase/docs, scoreboard between rounds, decision log) — but
stops at convergence **for its own scope**, not the whole feature. A pass converges when its
narrow branch list is fully `[DECIDED]`/`[ASSUMED]`-confirmed; it does not need to re-walk the
other passes' branches.

Pass 1.5 sits where it does because `slices[].files` is **structurally immutable after step 3's
scaffold** ([`spec-schema/frontmatter-schema.yaml`](../spec-schema/frontmatter-schema.yaml)) and pass 2 draws those globs
over the module layout — a structure decision that moves a file has to land before slicing. It is
the only pass that can end without asking anything: see its self-collapse rule.

## Interview passes run in the MAIN LOOP, not a subagent

`AskUserQuestion` is main-loop only. A subagent cannot interview anyone, so **delegating a grill-me
pass to `arch`/`foreman` produces a self-serve research pass, not an interview** — the gates
below ("all `[ASSUMED]` confirmed", "the user explicitly confirms the summary") are then unmeetable
and get silently skipped.

So, for each of the four passes:

- **Do the interview yourself, in the main loop.** Follow `protocol.md` directly: research
  self-serve first (delegate *research* freely — that's what subagents are for), then ask the user
  with `AskUserQuestion`, one question per call, each carrying your recommendation.
- **Delegate the reading, not the asking.** A subagent is the right tool for "read these five repos
  and report the chain shapes"; it is the wrong tool for "find out what the user wants".
- **If you do delegate a pass** (long research legs, model-tier reasons), brief it with the relay
  contract (questions always reach the human): it must return
  `⚑ RATIFY: <question> — <options> — <recommendation>` items rather than deciding, and must state
  that it had no `AskUserQuestion`. You then put every `⚑ RATIFY` item to the user before building
  on it, and `SendMessage` the answers back if the child needs to continue.
- **Never** let a child's self-serve call stand in for a human ratification on a one-way door, a
  public API or behaviour change, or a product decision. If a child's report shows it made such a
  call, say so plainly and put the question to the user.

Applies hardest to pass 1 (`arch`), whose entire scope is surfacing decisions the human owns.

## Decision log carries forward, no JSON hand-back

The protocol's decision log (see [decision-log.md](../../grill-me/references/decision-log.md)) is the carry-forward
mechanism between passes — each pass reads its predecessors' logs as settled context (do not
re-litigate `[DECIDED]` items). This is plain in-context state, not a structured hand-off object:
only step 3's decision-blob (see [decision-blob.md](decision-blob.md)) turns the accumulated log
into JSON, and that happens once, after pass 2, not after every pass.

Pass 1.5's structure decisions are the one exception to "the blob carries it forward" — the blob's
shape is LOCKED and must not grow a `code_structure` key, so they persist as `plan.md`'s
`## Code Structure` section, written at step 3d. See
[templates/structure-grill.md](templates/structure-grill.md) § *Output*.

Apply the protocol's three-gate ADR test at final convergence (after pass 3) exactly as documented
in [decisions.md](../../grill-me/references/decisions.md) — durable architectural decisions still get persisted to
`.agents/decisions/`, `/spec` doesn't change that behavior.

## Prototype escape hatch

The protocol's prototype escape hatch (`protocol.md` §"Prototype escape hatch") applies in all
four passes — most naturally in pass 1.5, where API ergonomics and state-machine shapes are exactly
the "I won't know until I see it" category. When accepted, build it with the prototype skill (it ships later; skip this step until then), keep the
asset durable (`.agents/prototype/<name>/`, never `--light`), and register it onto its slice at
plan.md step 8 via `~/.dg/bin/dg-skills spec prototype-ref` — do not invent a separate prototype-budget counter
here; `/spec` has no multi-phase budget to track since it only has four passes total (lighter than
its predecessor's multi-phase prototype-budget cap).
