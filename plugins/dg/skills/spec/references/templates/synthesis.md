# Synthesis Template (plan.md step 6)

One launch: **dg:foreman**, `[fable, xhigh]`. Runs after all `roundtable/slice-<N>.md` files
are populated (step 5).

## Launch prompt

> [Common directives.] Read every `<bundle>/roundtable/slice-<N>.md` (one per slice) and
> `<bundle>/plan.md`. Each slice file carries that slice's own-review findings — numbered
> `[AREA]` recommendations and any `[OPEN — escalate]` items.
>
> Synthesize across all slices:
>
> 1. **Fold standard `[AREA]` recommendations** into a proposed edit list for `plan.md` — grouped
>    by slice, each edit stated as a concrete diff-shaped change (add/remove/reword a checklist
>    item, tighten a Contracts entry, adjust `depends_on`).
> 1. **Surface cross-slice conflicts** — e.g. two slices assuming incompatible shapes for a shared
>    interface, or a dependency edge the per-slice reviews missed (slice B's reviewer didn't know
>    slice A's reviewer changed an assumption). These become `[OPEN — escalate]` items even if
>    neither individual review flagged them.
> 1. **Collect every `[OPEN — escalate]` item** verbatim from the slice files, deduplicated.
>
> Output: the proposed edit list (for the orchestrator to apply to `plan.md` in step 7), then the
> deduplicated `[OPEN — escalate]` list, then a one-line verdict: `"clean"` (nothing to escalate) or
> `"N items need a gaps pass"`.

## Handoff to the grill-me gaps pass

If the verdict is not `"clean"`, the orchestrator runs grill-me pass 3 (see
[../grill.md](../grill.md)) scoped to exactly the `[OPEN — escalate]` list this synthesis
produced — do not re-open branches the earlier passes already converged on. Pass 3's decision
log resolves each item to `[DECIDED]`; those decisions feed step 7's `plan.md` edit.
