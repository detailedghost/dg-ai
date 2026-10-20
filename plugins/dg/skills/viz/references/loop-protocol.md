# Viz Loop Protocol

## Response file shape

Written by the browser form to `$(~/.dg/bin/dg-skills stash -G viz <slug>/response.json)`:

```json
{
  "slug": "my-slug",
  "timestamp": "2026-06-17T...",
  "answers": [
    {"type": "decision", "index": 0, "answer": "Choice A"},
    {"type": "decision_question", "index": 1, "answer": "Why not option B?"},
    {"type": "open_question", "index": 0, "answer": "Q3 cutover"}
  ]
}
```

## Primary flow: blocking wait

Use the **namespaced slug** returned in the `VIZ_PATH` output from `render`, not the original base slug.

```sh
# Capture the namespaced slug from render
OUT=$(VIZ_DIR=... ~/.dg/bin/dg-skills viz --input payload.json --no-open)
VIZ_SLUG=$(echo "$OUT" | grep VIZ_PATH | sed 's|.*viz/\(.*\)/payload.*|\1|')
# Then block on it
~/.dg/bin/dg-skills viz wait "$VIZ_SLUG" --merge --timeout 600
```

Returns ~2s after the user clicks Confirm. Internally detects `response.json`, runs `doMerge`, deletes the file, re-renders, and prints the summary. Use this instead of `ScheduleWakeup` — no 60s floor.

## Merge command output

`~/.dg/bin/dg-skills viz wait <slug> --merge` (or `~/.dg/bin/dg-skills viz merge <slug> --no-open`) prints to stdout:

```json
{
  "resolved": ["decision[0]: \"...\" → \"Choice A\""],
  "threads": [{"index": 1, "question": "...", "userText": "Why not option B?"}],
  "pending_decisions": [{"index": 1, "question": "..."}],
  "open_questions_remaining": 0,
  "all_clear": false
}
```

The merge command also: applies all answers, deletes `response.json`, re-renders.

## Merge logic per answer type

| type | action |
|------|--------|
| `decision` | set `decisions[index].answer`; clear thread |
| `decision_question` | append `{role:"user", text}` to `decisions[index].thread`; decision stays pending |
| `open_question` | push to `open_questions_resolved`; remove from `open_questions` |

## Decision thread handling

When `merge` summary has `threads` entries:

1. `~/.dg/bin/dg-skills viz get <slug> decisions` — user message already appended by merge
2. Compose Claude's reply to the question
3. Directly edit `payload.json`: append `{role:"ai", text:"<reply>"}` to `decisions[index].thread`
4. Re-render: `~/.dg/bin/dg-skills viz --input $(~/.dg/bin/dg-skills stash -G viz <slug>/payload.json) --no-open`
5. Block again: `~/.dg/bin/dg-skills viz wait <slug> --merge --timeout 600`
6. Loop until a `decision` type answer arrives and `all_clear: true`

## Timeout & resume

If a `wait` times out, it exits non-zero, marks the board **stale**, and prints the exact resume command:

```sh
~/.dg/bin/dg-skills viz wait <namespaced-slug> --merge --resume
```

`--resume` grabs a response that arrived while no `wait` was running (it checks before polling). The stale marker clears on the next render, merge, or resume — so a timed-out session is never lost, just flagged.

## Manual fallback

If the loop isn't running, user says **"/viz responses ready for \<slug\>"** (the viz-skill mention keeps pickup fast) — check for `response.json` and run `merge` the same way.

## Stopping the loop

Once `all_clear: true` in the merge summary — do not reschedule.

## Review-submit round-trip (`~/.dg/bin/dg-skills viz review`)

Same backchannel as the decision loop above — no parallel mechanism. Differences:

1. The board is built entirely by `~/.dg/bin/dg-skills viz review --repo ... --base ... --head ...` (deterministic, no model). It mints `.token`+`.secret` exactly like `render.ts` does for planning boards.
2. The reviewer's "Submit review" button (`ReviewSection.astro`) POSTs one answer of a new type, `review_submit`, whose `answer` field is the **whole review, JSON-stringified**:
   ```json
   {"slug": "...", "nonce": "...", "hmac": "...", "answers": [
     {"type": "review_submit", "index": 0, "answer": "{\"verdict\":\"approve\",\"summary\":\"...\",\"fileApprovals\":[...],\"lineComments\":[...]}"}
   ]}
   ```
3. Because a review board always has a `.secret` (review.ts mints it unconditionally), `/api/respond`'s `validateHmac` will fail-closed on an unsigned POST — the browser cannot compute the HMAC itself (the secret never reaches it). The board first POSTs `{slug, answers}` to `/api/sign` (same-origin only, mirrors `validateHmac`'s exact `sha256(slug + JSON.stringify(answers) + nonce)` construction) to get a valid `hmac`, then POSTs to `/api/respond` as normal. This is a small same-origin signing helper, not a second backchannel — the merge still happens exclusively in `/api/respond`.
4. `respond-core.ts`'s `doMerge` has a `review_submit` branch: it `JSON.parse`s the answer and stores it on `payload.review_result`. A review payload has no `decisions`/`open_questions`/`approval`/`permissions` to gate on, so `all_clear` computes to `true` as soon as this lands — no extra wiring needed.
5. Block with `~/.dg/bin/dg-skills viz wait <slug> --timeout 600` (or the `review-wait` alias — identical implementation) exactly like the decision loop. It returns as soon as `all_clear` flips, which (per the `wait --merge` behavior note in `cli.md`) has already happened server-side by then.
6. Read the result: `~/.dg/bin/dg-skills viz get <slug> review_result` → the parsed `{verdict, summary, fileApprovals[], lineComments[]}` object. See `payload-schema.md`'s "review template" section for the exact shape.

No thread/decision handling applies to review boards — there is exactly one round-trip (submit → all_clear), not an iterative back-and-forth.

## Interactive loop

When payload has pending decisions or `open_questions`, run as a blocking Bash call after rendering:
```sh
# Save the namespaced slug from render output first
VIZ_SLUG=$(VIZ_DIR=... ~/.dg/bin/dg-skills viz --input payload.json --no-open | grep VIZ_PATH | sed 's|.*viz/\(.*\)/payload.*|\1|')
~/.dg/bin/dg-skills viz wait "$VIZ_SLUG" --merge --timeout 600
```
Returns immediately when the user clicks Confirm — no polling floor. Prints the compact JSON summary (same as `merge`).

After `all_clear: true`, annotate resolved decisions with rationale:
```sh
~/.dg/bin/dg-skills viz annotate "$VIZ_SLUG" $(~/.dg/bin/dg-skills stash -G viz $VIZ_SLUG/patch.json)
```

If `threads` entries in the summary, see `references/loop-protocol.md` for thread handling.

**Never read/rewrite the full payload manually** — use `wait --merge`, `merge`, or targeted `get`.
