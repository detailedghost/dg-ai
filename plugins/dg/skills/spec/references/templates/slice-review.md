# Slice Review Template (plan.md step 5)

One launch per slice, fanned out in parallel. Each launch is that slice's **assigned `agents.primary`**
(from `/assign`, step 3) reviewing its own slice before any code is written — a design-level
sanity pass, not an implementation.

## Model/effort — sonnet default, per-slice escalate

**Default: `sonnet`, medium effort**, regardless of what `/assign` picked as the slice's engineering
persona — this is a review pass, not the build itself, so the model tier is decoupled from the
primary agent's usual pin.

Before the fan-out, ask the user **once, per-slice** (batch up to 4 slices per `AskUserQuestion`
call): *"Escalate slice `<N>` (`<name>`) review to opus-5/medium?"* — **Yes** / **No (sonnet
default)**. Ceiling is `opus-5` at `medium` effort; never go higher for this pass regardless of
slice risk — a slice that needs more than that should be flagged as `[OPEN — escalate]` for the
human instead of burning tokens on a bigger review model.

## Launch prompt

> \[Common directives — read `.agents/school/` topic file if present.\] You are `<agents.primary>`,
> assigned as this slice's primary engineer. Before any code is written, review your own slice for
> soundness. Read:
>
> - `<bundle>/plan.md` — full bundle context (all slices, dependency graph).
> - `<bundle>/roundtable/slice-<N>.md` — your slice's findings file (currently a shell; you are
>   about to fill it).
>
> Review this slice (`<name>`, files: `<files>`) for: **feasibility** (can it be implemented
> independently within its declared `depends_on`?), **completeness** (missing acceptance criteria
> or Contracts gaps?), **risk** (integration risk with sibling slices — same-layer slices MUST
> touch disjoint files — `~/.dg/bin/dg-skills spec lint-waves` already checked the globs, so this is the second
> line of defense: look for overlap the globs cannot show, such as a generator run or shared
> fixture), **ambiguity** (any `[ASSUMED]` item from the decision log that needs
> tightening before engineering starts), and **structure conformance** (if `plan.md` has a
> `## Code Structure` section, does this slice's Engineering checklist actually honour the type
> shapes, module homes, and error conventions settled there? A conflict between your slice and that
> section is an `[OPEN — escalate]`, not something to quietly work around).
>
> Write your findings directly into `<bundle>/roundtable/slice-<N>.md` (Edit/Write), replacing the
> shell placeholder. Format: numbered recommendations, `N. [AREA] recommendation — rationale`. If
> clean: `"no recommendations"`. Also flag any item that genuinely needs the human decision-maker as
> `N. [OPEN — escalate] question — options`.

## Collection (plan.md step 6 depends on this)

The orchestrator does NOT triage these findings inline — that's step 6's job (foreman
synthesis). This step's only output is one populated `roundtable/slice-<N>.md` per slice.
