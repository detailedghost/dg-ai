# Refine chain

The chain is the record of every round. It lives in the artifact, in
`<script type="application/json" id="dg-chain">`, so it travels with the prototype and
shows in the bar's **Rounds** panel.

## Chain JSON

```json
{
  "name": "signup-form",
  "kind": "ui",
  "question": "Which signup layout gets people through fastest?",
  "round": 3,
  "base": "2B",
  "status": "open",
  "accepted": null,
  "history": [
    { "round": 1, "variants": ["A", "B", "C", "D", "E"], "decision": "approve", "variant": "C", "note": "organize the buttons" },
    { "round": 2, "variants": ["A", "B", "C", "D", "E"], "decision": "tweak", "variant": "B", "note": "round the corners" },
    { "round": 2, "variants": ["A", "B", "C", "D", "E"], "decision": "approve", "variant": "B", "note": "tighten the spacing" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `name` | The prototype slug. It also scopes the viewer's saved mode, width and note draft. |
| `kind` | `ui`, `walkthrough` or `logic`. |
| `question` | The question this prototype answers. |
| `round` | The round on screen now, starting at 1. |
| `base` | The pick this round was built from, as round and key (`2B`), or `null` in round 1. |
| `status` | `open` while picking, `accepted` once the chain ends. |
| `accepted` | `null`, or `{ "round": 3, "variant": "D", "note": "" }` once the chain ends. |
| `history` | One entry per decision, oldest first: `round`, the `variants` shown, `decision` (`approve`, `tweak`, `reject` or `more`), the `variant` it named, and the `note`. |

## Each reply

| Reply | Do this |
| --- | --- |
| `approve C` | Add the entry. Set `status` to `accepted` and `accepted` to this round and key. Show C. The chain ends. |
| `approve C: <note>` | Add the entry. Build round N+1: the same number of variants, all starting from C and changing only what the note asks. Set `base` to `NC`. |
| `tweak C: <note>` | Add the entry. Edit C in place. Same round, no new variants. Show C again. |
| `reject: <note>` | Add the entry. Rework this round's variants against the note. Same round number. |
| `more` or `more: <note>` | Add the entry. Build round N+1 with new variants from the same `base`, steered by the note. |
| `done` | End the chain with the last approved variant, as for `approve`. With no approval yet, ask which one to keep. |

A note that starts with `[was viewing X]` came from the bar: X is what the user was looking at
when they wrote it.

Each round starts from the previous winner only. There's no branching and no way back to an
earlier round, but every past decision stays in `history`.

Keep the artifact the same between rounds: same template, same bar, same name. Only the
items and the chain JSON change.

## ACCEPTED.md

When the chain ends, give the user this block:

```markdown
# signup-form: accepted

- question: Which signup layout gets people through fastest?
- accepted: round 3, variant D (Inline steps)
- note: none
- verify root: data-verify-root="signup-form"

## Why

One or two sentences, in the user's words where you have them.

## Rounds

- round 1: approve C (organize the buttons)
- round 2: tweak B (round the corners), approve B (tighten the spacing)
- round 3: approve D
```

The accepted design is the source of truth for whatever is built from it. Whoever builds it
reproduces its layout and feature set, and asks before departing from it.
