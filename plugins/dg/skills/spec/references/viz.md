# viz integration — plan-verify board (plan.md step 8)

Stripped descendant of its predecessor's `viz.md` — that file mapped a board primitive to every
phase boundary; `/dg:spec` only ever renders **one** board, the plan-approval verify at step 8. There
is no per-phase map here.

Run `~/.dg/bin/dg-skills viz doctor --json` first (see the [viz skill](../../viz/SKILL.md)); on probe failure announce
"running in terminal mode" and fall back to a plain `AskUserQuestion` approval instead of the board.

> **Residual threat:** board-approval is a UX gate hardened against CSRF + naive/cross-user
> forgery, NOT a defense against same-uid code execution. Anyone who can read `.secret` can forge a
> response locally.

## Decided vs pending decisions

Decision-pending semantics follow [`payload-schema.md`](../../viz/references/payload-schema.md)'s `decisions[].answer` field (empty or
`"tbd"` blocks approval); surface any `[OPEN — roundtable]` deferral there rather than omitting it.

## Payload

Uses `template: "spec"` — the template that owns `slices[]`/`contracts[]`/`roundtable[]` per
[`viz/references/payload-schema.md`](../../viz/references/payload-schema.md)'s "spec template" section:

```json
{
  "template": "spec",
  "slug": "<slug>",
  "title": "Plan — <feature name>",
  "subtitle": "Ready for approval",
  "spec_status": {
    "status": "draft",
    "version": "<plan.md version>",
    "date": "<plan.md date>",
    "feature": "<feature name>"
  },
  "scope": {
    "inScope": ["<scope.included item>", "..."],
    "outOfScope": ["<scope.excluded item>", "..."],
    "assumptions": ["<any surviving [ASSUMED] item>", "..."]
  },
  "slices": [
    {
      "id": 1,
      "name": "<slice name>",
      "status": "pending",
      "description": "<slice brief>",
      "dependsOn": [],
      "agents": {"primary": "<slices[].agents.primary>", "qa": ["<slices[].agents.qa[]>"]}
    },
    {
      "id": 2,
      "name": "<slice name>",
      "status": "pending",
      "description": "<slice brief>",
      "dependsOn": [1],
      "agents": {"primary": "<slices[].agents.primary>"}
    }
  ],
  "contracts": [],
  "roundtable": [
    {
      "name": "Slice 1 — <slice name>",
      "recommendations": [
        {"text": "<recommendation>", "flavor": "edit", "outcome": "accepted"}
      ]
    }
  ],
  "decisions": [
    {
      "question": "<grill-me question>",
      "answer": "<the [DECIDED] answer>",
      "rationale": "<why>"
    }
  ],
  "open_questions": [],
  "approval": {
    "required": true,
    "prompt": "Approve this plan to begin engineering?"
  }
}
```

`spec_status` mirrors `plan.md`'s own frontmatter (`status`/`version`/`date`/`feature`) — at
plan-approval `status` is still `draft`. `scope` activates the Scope section
(`inScope`/`outOfScope`/`assumptions` arrays). `slices[].dependsOn` is an array of sibling `id`
**numbers** (matches `plan.md`'s `depends_on`), and `slices[].agents` mirrors that slice's
`agents.primary`/`agents.qa[]`.

`contracts[]` is usually empty at plan-approval — endpoint shapes are an engineering-time decision;
populate an entry only when a slice's Testing Criteria/Contracts already specifies a concrete
request/response shape.

`roundtable[]` carries step 5's per-slice review findings: one entry per reviewed slice, `name`
identifying the slice, `recommendations[]` pulled from that slice's `<bundle>/roundtable/slice-<N>.md`
(`flavor` from its `[AREA]`/`[OPEN — escalate]`/`[PROTOTYPE]` marker, `outcome` from synthesis's
step 6 triage).

Every `decisions[]` entry needs a non-empty `answer` — pull these from the accumulated grill-me
decision log across all four passes, not just the synthesis pass. Pass 1.5's structure decisions
belong here too: carry each one's alternatives into `rationale` (`<chosen> over <rejected> — <why>`)
so the approver sees what was traded away, not just what was picked.

## Render + block

```sh
~/.dg/bin/dg-skills viz --input payload.json --no-open
# grab VIZ_SLUG from the printed VIZ_PATH, same pattern every other loop uses
~/.dg/bin/dg-skills viz wait "$VIZ_SLUG" --merge --resume
```

Proceed only once `all_clear: true`. On approval, continue to step 9. On a requested change,
apply the edit to `plan.md` directly, re-render, and wait again — same edit-reapprove loop its
predecessor used, just without the second full plan-mode pass (this is a single board, not two).

**Never read/rewrite the full payload manually** — use `wait --merge`, `merge`, or targeted `get`
(see [`viz/references/cli.md`](../../viz/references/cli.md)).
