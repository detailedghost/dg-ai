# Structure Grill Template (plan.md step 1.5)

The code-building pass. Runs **between** the arch grill (step 1, architecture placement) and the
foreman grill (step 2, slice ordering), because `slices[].files` is **structurally immutable
after scaffold** ([`spec-schema/frontmatter-schema.yaml`](../../spec-schema/frontmatter-schema.yaml), `slices` item
mutability) — slice boundaries get drawn over the module layout, so any structure decision that
moves a file has to land before slicing, not after.

Scope: **code-surface contracts** — the shapes the engineers will build against.

- Shared types/interfaces, and their fields.
- Module and file homes — what lives where, what gets a new file vs. extends an existing one.
- Data shapes crossing a boundary (payloads, records, enums, state trees).
- Error/result conventions — thrown vs. returned, error type shape, failure vocabulary.
- Reuse vs. new — which existing abstraction gets extended, and what genuinely has no home yet.
- Extension seams — the one or two places a near-future variant would plug into.

## Admission test — two gates, both required

A question may only be **asked**, and a decision only **recorded**, if it passes both:

1. **Crosses a boundary.** Two or more slices consume it, *or* it is visible outside the feature
   (public API, wire format, DB schema, a shared `lib/`/`common/`/`util/` surface).
1. **Divergence costs rework.** If two engineers guessed differently, reconciling means an
   interface mismatch, a migration, or a rename cascade — not a local refactor.

One slice's internals fail gate 1. A choice that's a five-minute rename later fails gate 2.

> **Ratify contracts, never implementations.** Signatures, type shapes, and file homes another
> slice imports are contracts. Function bodies, private helpers, and internal naming are
> implementation — the engineer decides those with a keyboard in hand.

Hard output cap: **one line per decision plus a rationale**. No code blocks, no pseudo-code, no
field-by-field type listings unless the fields themselves are the cross-slice contract. If a
decision cannot be stated in one line, it is an implementation, not a contract — drop it.

This generalizes something the pipeline already believes: `testing[]`'s first items are the
Contracts (see [../decision-blob.md](../decision-blob.md)). This pass does the same for code
surfaces.

## Who runs it

**Main-loop interview, always** — subagents have no `AskUserQuestion`, so a delegated pass produces
a research report, not an interview (see [../grill.md](../grill.md) § *Interview passes run in the
MAIN LOOP*). The agent below is the **research** persona, not the interviewer.

**Research delegation: the repo's dominant language agent (`js` / `python` / `csharp` / …) at
`sonnet`, medium effort.** Idiom knowledge is what this pass needs; arch's seam knowledge was
already spent in pass 1. When no dominant language is obvious, continue with `arch` (it holds pass
1's context). Do **not** use `foreman` — wrong skill set — and do not spend a second
`fable`/`xhigh` pass here; the hard architecture calls happened in step 1.

Research legs must honour the global *Reuse before building* and *Shared utilities, not local ones*
rules: before any question proposes a new type/module/helper, the research must have searched for
an existing one and must say what it searched.

## Interview shape

Follow `grill-me/references/protocol.md`'s rounds as normal (self-serve research → present findings
→ one question per `AskUserQuestion` call → record → scoreboard), with two additions this pass
requires:

- **Every question carries a recommendation *and* the alternatives.** The `AskUserQuestion` options
  are the real candidate structures, the recommended one first and labelled `(Recommended)`, each
  option's description naming its concrete trade-off — not "Option A / Option B". The user is
  reacting to a designed proposal, never authoring from scratch.
- **The prototype escape hatch applies** (`protocol.md` § *Prototype escape hatch*) — API ergonomics
  and state-machine shapes are exactly the "I won't know until I see it" category. Route accepted
  prototypes per plan.md step 8.

## Self-collapse — the default skip

Run the research legs **first**, then apply the admission test to the candidate list.

- **Empty list → converge with zero questions.** Print a one-paragraph *"no contested code
  surfaces"* summary naming what was searched and which existing patterns the feature rides on, and
  move to step 2. This is the expected outcome for a feature that purely extends established
  patterns — it is a success, not a skipped step.
- **Single-slice bundles → do not run this pass separately.** No cross-slice surface can exist, and
  any public-surface question is already arch's territory — fold the surviving branches into step
  1's arch grill.

> **GATE:** either the candidate list is empty (collapse summary printed), or every admitted branch
> is `[DECIDED]` with its alternatives recorded and every `[ASSUMED]` confirmed.

## Output — the `## Code Structure` section

Decisions live in the grill-me decision log through steps 1.5–3, then get written into `plan.md`
**after** scaffold (plan.md step 3d) via:

```sh
~/.dg/bin/dg-skills spec append-section <bundle>/plan.md --section "Code Structure" "<body>"
```

`append-section` creates the heading at end-of-file when absent and takes multi-line text (quote at
the call site). It is **not** part of the decision blob — the blob's shape is LOCKED
([../decision-blob.md](../decision-blob.md)) and must not grow a `code_structure` key.

One entry per decision:

```md
### <surface name>
- **Decision:** <one line — the contract>
- **Home:** `<path or glob>`
- **Rationale:** <one line — why this over the alternatives>
- **Alternatives:** <A — why not>; <B — why not>
- **Applies to:** slices <N>, <M>
```

`Applies to` is written at step 3d, once slice ids exist. A decision that ends up applying to
exactly one slice failed gate 1 in hindsight — drop it and let that slice's engineer decide.

Downstream, this section is read by each slice's engineer (`/sdlc`'s `slice-engineering.md` and
`slice-engineering-proxy.md` both list it), and checked against per-slice reviews at step 5.
