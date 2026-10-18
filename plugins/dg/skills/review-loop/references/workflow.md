<!-- markdownlint-disable MD013 MD033 MD041 MD060 -->

# /review-loop Workflow

Each phase lists `IN:` (required state) and `OUT:` (produced state).
Gates are hard stops. The skill has no persistent state — round count
derives from the PR on each invocation, and Copilot's responses are
read through `"$DG" address`. Resolve `DG` from
[../SKILL.md](../SKILL.md#runtime-and-skill-paths) in each fresh shell.

## Phase 0 — Argument Parsing

IN: raw invocation string, environment.
OUT: `maxRounds` (int), `skip` (bool), `noRetrigger` (bool),
`auto` (bool, default `true`), `waitTimeout` (int seconds, default `1800`).

- `-r N`/`--rounds N` → `maxRounds = N` (reject values < 1).
- `-k`/`--skip` → `skip = true`.
- `-s`/`--single` → `auto = false`. Run one round step and exit.
- `-n`/`--no-retrigger` → `noRetrigger = true`, `auto = false`. Implies
  `--single` — skips the Copilot re-request at the end of the round.
- `-w <sec>`/`--wait-timeout <sec>` → `waitTimeout = <sec>` (reject values < 1).
- `-p <backend>`/`--proxy <backend>` present → hand off entirely to
  [proxy-workflow.md](proxy-workflow.md); nothing below in this file
  applies.

`maxRounds` resolution when `--rounds` is omitted: read
`REVIEW_LOOP_MAX_ROUNDS` from the environment; when set to a positive
integer, use it. Otherwise default to `2`.

When `skip` equals `true`: print `review-loop: skipped` and exit 0.

## Phase 1 — Environment Probe

IN: none.
OUT: `prNumber`, `prUrl`.

1. Run `"$DG" vcs-provider capabilities` (see SKILL.md's runtime setup). It needs no provider binary — the
   capability set is frozen per provider kind at construction time. It
   fails loud when no provider resolves at all: non-zero exit, the
   reason on stderr (`vcs-provider capabilities: <reason>`),
   nothing on stdout. On that failure, print the stderr line verbatim
   and exit 1 — do not try to parse stdout as JSON. On exit 0, parse
   the printed `{kind, aiReviewBot, aiReviewBotNames, nativeStacking}`
   object.

   `aiReviewBotNames` names the reviewers whose comments this loop
   consumes. GitHub reports `["copilot"]`. GitLab reports whatever
   `VCS_GITLAB_AI_REVIEW_BOT` explicitly configures (comma-separated).
   Unset, empty, or `none` means no reviewer; there is no machine-specific
   default. Configured names use the bot-review flow so real findings
   remain visible.

   Branch on the names, not on the boolean alone:

   - `aiReviewBotNames` contains `copilot` → the GitHub Copilot flow,
     steps 2 and 3 below and the rest of this file.
   - `aiReviewBot == true` without `copilot` → the **bot-review flow**
     in Phase 1b. Do NOT route to proxy mode: a reviewer has findings
     to read.
   - `aiReviewBot == false` → proxy mode, the paragraph below.

   `aiReviewBot == false` → print `review-loop: no AI review bot on this provider — routing to local proxy review; findings stay local and won't post to the MR.`, then auto-select
   [Proxy mode](../SKILL.md#proxy-mode) as if `--proxy <backend>` had
   been passed — the user does not have to pass `--proxy` themselves.
   `<backend>` comes from the required
   `REVIEW_LOOP_DEFAULT_PROXY_BACKEND` environment variable. When it
   is unset, fail loud: print `review-loop: REVIEW_LOOP_DEFAULT_PROXY_BACKEND is not set — set it to one of codex|copilot|pi|opencode|cortex|grok to auto-route on this provider, or pass --proxy <backend> explicitly.` and exit 1. Never guess a backend
   and never fall back to one silently. Findings reached this way are
   LOCAL-ONLY, the same as any other `--proxy` run: they surface
   through `/address` and are never posted back to the merge request.
   On a successful auto-route, hand off entirely to
   [proxy-workflow.md](proxy-workflow.md); nothing below in this file
   applies for the rest of this invocation.

1. Run `"$DG" address view-pr` and read `.number`, `.url`, `.headRefName`. No open PR on
   this branch → print
   `review-loop: no open PR for this branch; open one first.`
   and exit 0.

1. Run `"$DG" address check-copilot`. `available == false` →
   print `review-loop: Copilot reviewer unavailable here; skipping.`
   and exit 0. (`assumed-available` counts as available — real errors
   surface at Phase 3 trigger time.)

Steps 2 and 3 are Copilot-only. The bot-review and proxy routes leave
this phase at step 1 and carry their own gates.

GATE: on the Copilot route, all three succeed.

---

## Phase 1b — Bot-review flow (a non-Copilot reviewer)

Reached when `aiReviewBot == true` and `aiReviewBotNames` does not
contain `copilot` — for example GitLab with an explicitly configured reviewer. The reviewer posts
on the merge request by itself, so this loop never triggers it; it
waits for the review and consumes it.

IN: `aiReviewBotNames`, `maxRounds` (`--rounds N`, `REVIEW_LOOP_MAX_ROUNDS`, else 2).
OUT: `roundsUsed`.

Round accounting, so this path is capped like the others: a round is
consumed each time step 3 hands work to `/address`, and only then.
Waiting in step 5 consumes nothing. Stop when `roundsUsed` reaches
`maxRounds` and print `review-loop: <maxRounds> round(s) used; re-run
to continue.`. Under `--single` / `--no-retrigger`, run one round and
exit.

1. `"$DG" address view-pr` resolves the current branch's merge
   request. No merge request → print `review-loop: no open MR for this
   branch; open one first.` and exit 0.
1. `"$DG" address check-bot-review` reports
   `{available, bots, present, threads, unresolved, latestAt}` for that
   merge request. It reads the same GitLab discussions `/address`
   consumes, so `present` means findings really are on the MR.
1. `present == true` and `unresolved > 0` → invoke the Skill `address`
   with no `-l`, giving it
   `-m "<bots> is the reviewer on this merge request."`. `/address`
   gathers the threads through `gather-unresolved`, fixes, replies and
   resolves. That consumes one round. In auto mode, loop back to step 2
   for the next round; otherwise exit.
1. `present == true` and `unresolved == 0` → print
   `review-loop: <bots> review present, all threads resolved; nothing
   to address.` and exit 0.
1. `present == false` → the reviewer has not posted yet. Poll
   `check-bot-review` every 60 s up to `--wait-timeout` (default 1800;
   this flow honours that flag, the same as default mode). Still absent
   at the cap → print `review-loop: <bots> has not posted on this MR
   within <timeout>s; re-run once it has.` and exit 0. Use `latestAt`
   to tell a fresh review from the one already addressed: a `latestAt`
   no newer than the previous round's is not a new review, so keep
   waiting rather than re-running `/address` on the same threads.

Never fall through from this flow to proxy mode. A reviewer that is
configured but silent is a wait, not an absent reviewer, and routing to
proxy mode here is exactly the failure this flow exists to prevent: it
would report a clean "nothing to do" while findings sit unread.

GATE: `/address` ran, or the flow exited with a message naming the
reviewer and its state.

______________________________________________________________________

## Round Step (Phases 2–7)

One full review cycle. Both single-shot and Auto Driver call this
unit. The only difference between them is what happens after Phase 7
returns.

IN: `maxRounds`, `noRetrigger`, `auto`, `waitTimeout`, `prUrl`.
OUT: terminal (exits) OR `sinceIso` when `auto == true` and a
re-trigger fired successfully.

______________________________________________________________________

## Phase 2 — Round Counter

IN: Phase 1 state.
OUT: `roundsDone` (int), `maxRounds` (possibly clamped).

1. `"$DG" address count-copilot-reviews` → `roundsDone`.
1. When `noRetrigger == true`: `maxRounds = min(maxRounds, roundsDone + 1)`.
   This folds no-retrigger into the existing round-cap logic — no
   separate branch is needed downstream.
1. When `roundsDone >= maxRounds` → print
   `review-loop: max rounds reached (N/N); stopping.` and exit 0.

GATE: `roundsDone < maxRounds`.

## Phase 3 — State Decision

IN: `roundsDone`, `prUrl`.
OUT: next action: `close-no-findings` | `trigger` | `act` | `wait`.

1. **No-findings close-out check** — Run
   `"$DG" address check-no-findings <prUrl> <lastCommitTs>` where
   `lastCommitTs = git log -1 --format=%cI HEAD`. The helper owns the
   graphql scan, the pattern match, and the `REVIEW_LOOP_NO_FINDINGS_PATTERN`
   override (jq Oniguruma syntax). A `noFindings:true` result → action
   `close-no-findings`.

1. When `roundsDone == 0` → action `trigger`.

1. Otherwise run `"$DG" address fetch-copilot-review`.

   - `submittedAt == null` → `wait`.
   - Let `latestReviewTs = submittedAt` and
     `lastCommitTs = git log -1 --format=%cI origin/<branch>` (fall
     back to local `HEAD` when the remote ref lags behind).
   - `latestReviewTs > lastCommitTs` → action `act`.
   - Otherwise → action `wait`.

Branches below execute based on this decision.

### 3z. Action `close-no-findings`

Copilot reviewed via an issue-comment acknowledgment (posted by
`copilot-swe-agent`) matching the no-findings pattern. Nothing
actionable — close the loop cleanly.

1. Print:

   ```text
   review-loop: Copilot reviewed via comment, no findings — closing loop.
   comment: <bodyExcerpt>
   ```

   Use the `bodyExcerpt` from the helper's response.

1. Exit 0. Do not invoke the antagonist, `/address`, or re-trigger.
   The round counter is not consumed.

### 3a. Action `trigger`

1. Capture `sinceIso = now()` (ISO-8601 UTC).

1. `"$DG" address request-copilot`. Default method posts an
   `@copilot review` comment on the PR. The comment-based trigger works
   even on repositories where the Copilot GitHub App isn't wired up to
   accept review requests, and Copilot posts a review authored by
   `copilot-pull-request-reviewer`.

1. **Verify engagement** with the retry ladder
   (see [Trigger retry ladder](#trigger-retry-ladder) below). On final
   failure, exit 1 with the `engagement-timeout` diagnostic.

1. Print:

   ```text
   review-loop: Copilot review requested via @copilot comment (round 1 of <maxRounds>).
   Re-run /review-loop when the review is posted.
   ```

1. Exit 0.

### 3b. Action `wait`

1. Print:

   ```text
   review-loop: awaiting Copilot re-review (round <roundsDone+1> of <maxRounds>).
   Re-run /review-loop when it lands.
   ```

1. Exit 0.

### 3c. Action `act`

Proceed to Phase 4. The real work happens here.

GATE: one of trigger / wait / act fired.

## Phase 4 — Antagonist Filter (Act phase only)

IN: Phase 3 `fetch-copilot-review` JSON.
OUT: verdict file path `$("$DG" stash review-loop <prNumber>.verdicts.json)`.

1. Write the `.comments` array to
   `$("$DG" stash review-loop <prNumber>.comments.json)`.

1. Locate the spec file (best effort):

   - When branch name or any commit subject on this branch references
     `<NNN>_<slug>` — look up
     `.agents/spec/<NNN>_<slug>/plan.md`. Skip when not found.
   - Otherwise skip spec context.

1. Launch the `copilot-antagonist` agent. Prompt:

   ```text
   Read <absolute path to this skill's references/antagonist-prompt.md> for rules and output format.
   Comments JSON: <absolute comments JSON path resolved by the caller>
   Spec (optional): <path or "none">
   Return ONLY the verdict JSON array — no prose, no code fences.
   ```

1. Parse the returned JSON. Schema: array of
   `{commentId, threadId, verdict, reason}`.
   Every input comment must have exactly one matching entry with
   `verdict` in the allowed set. On failure, print the raw
   agent output and exit 1.

GATE: parsed verdict array matches the comment set.

## Phase 5 — Apply Rejections

IN: verdict array.
OUT: filtered verdict array (`accept` + `strange` only).

For each verdict:

- `reject-illogical` →
  `"$DG" address resolve-with-reply <commentId> <threadId> "#rejected-by-antagonist: <reason>"`
  (the helper adds the `🤖` prefix automatically).
- `reject-other` → `"$DG" address resolve-silent <threadId>`.
- `accept` / `strange` → keep in filtered array.

Write filtered array to
`$("$DG" stash review-loop <prNumber>.verdicts.json)`.

When the filtered array has no entries (Copilot posted comments but
every one got rejected): skip to Phase 7 with no `/address` call.

GATE: all rejects processed.

## Phase 6 — Hand Off to /address

IN: filtered verdict file path, `roundNumber = roundsDone + 1`.
OUT: `/address` exit status.

Load [../../address/SKILL.md](../../address/SKILL.md), resolving it through
the configured personal skill root only if the sibling is unavailable. Invoke
that skill through the host's skill facility, or follow its instructions directly,
with arguments `--round <roundNumber> --verdicts <absoluteVerdictsPath>`.
Compute `absoluteVerdictsPath` with `"$DG" stash review-loop <prNumber>.verdicts.json`
in a shell first; pass the resulting path as one argument, not an unevaluated shell
substitution inside a tool's argument string.

`/address` handles:

- The verdict file as its work list (skip gather).
- Pausing on `strange` items via the host's question facility before fixing.
- Its normal fix → QA → commit+push → reply+resolve flow.

GATE: `/address` returns 0. Non-zero → surface the error and exit 1.
The round does **not** count as consumed (no Copilot re-trigger).

## Phase 7 — Re-trigger

IN: successful /address (or empty filtered array), `roundsDone`, `maxRounds`, `auto`.
OUT: terminal (exits) OR `sinceIso` returned to Auto Driver.

1. When `roundsDone + 1 < maxRounds`:

   - Capture `sinceIso = now()` (ISO-8601 UTC).

   - `"$DG" address request-copilot`.

   - **Verify engagement** with the retry ladder
     (see [Trigger retry ladder](#trigger-retry-ladder)). On final
     failure, exit 1 with the `engagement-timeout` diagnostic.

   - When `auto == true`: **return `sinceIso`** to the Auto Driver.
     Do not exit.

   - Otherwise (`--single` mode) print:

     ```text
     review-loop: round <N> complete. Copilot re-review requested.
     Re-run /review-loop when it lands.
     ```

     and exit 0.

1. Otherwise (`roundsDone + 1 >= maxRounds`), print:

   ```text
   review-loop: final round (<N>/<maxRounds>) complete. Not re-requesting.
   ```

   and exit 0 regardless of `auto`.

GATE: printed summary and exited, or returned `sinceIso` to Auto Driver.

______________________________________________________________________

## Auto Driver

Active only when `auto == true`. Wraps Round Step in a wait loop —
the only logic here is waiting between rounds; all round work stays
in Round Step.

IN: `prUrl`, `waitTimeout`, initial `sinceIso` from Phase 7.
OUT: terminal.

```
loop:
  sinceIso = Round Step()        # runs Phases 2–7; exits internally on terminal states
  "$DG" address await-copilot-review prUrl sinceIso --timeout=waitTimeout
    landed      → continue loop
    noFindings  → print close-out message (Phase 3z format), exit 0
    timeout 124 → print review-timeout message, exit 0
    error 1     → surface trigger-error line, exit 1
```

`"$DG" address await-copilot-review` owns the polling loop and calls
the provider internally each tick — idle time between rounds costs
zero LLM tokens.

## Trigger retry ladder

Used by Phase 3a and Phase 7 immediately after `request-copilot`. The
goal is to fail loud when Copilot didn't accept the trigger, instead
of waiting silently for a review that's never coming.

1. **Tier 1 — comment**: `"$DG" address request-copilot` (default, posts
   `@copilot review`). Then
   `"$DG" address verify-copilot-engaged <prUrl> <sinceIso> --timeout=300`.

   - exit 0 → engaged. Done.
   - exit 124 → no swe-agent ack within 300s. Continue to Tier 2.
   - exit 1 → persistent gh failure. Surface the `trigger-error` line
     and exit 1.

1. **Tier 2 — perturbed comment**: GitHub may have deduped Tier 1's
   identical body on the same head SHA.
   `"$DG" address request-copilot --method=retry-comment` (posts `@copilot please review the latest changes`). Then `"$DG" address verify-copilot-engaged <prUrl> <sinceIso> --timeout=300`. Same exit handling as Tier 1.

1. **Tier 3 — reviewer API**: comment-based triggers might be
   silently dropped if the Copilot App isn't installed for review
   requests on this repo. `"$DG" address request-copilot --method=reviewer`. If `gh`
   returns non-zero, surface the body verbatim — that's almost
   certainly an HTTP 422 telling the user Copilot isn't a valid
   reviewer here. Otherwise `"$DG" address verify-copilot-engaged <prUrl> <sinceIso> --timeout=300`.

1. **Final failure**: if all three tiers run without engagement, print:

   ```text
   review-loop: engagement-timeout — Copilot did not engage after 3 attempts.
   Tried: comment, retry-comment, reviewer.
   Check the repo's Copilot setup or push a new commit and retry.
   ```

   Exit 1.

The skill records `sinceIso` once at the start of Tier 1 and reuses
it across all tiers — the engagement check is "any swe-agent comment
newer than the original trigger time," not per-tier.

## Failure surface

Distinct exit messages so silent timeouts and silent trigger failures
can't be confused. Format: `review-loop: <state>: <diagnostic>` plus a
suggested next command.

| State | When | Exit | Suggested next |
| --- | --- | --- | --- |
| `landed` | Copilot review observed | (proceeds) | — |
| `no-findings-ack` | Phase 3z / Auto Driver noFindings | 0 | none |
| `engagement-timeout` | Trigger ladder all 3 tiers no engagement | 1 | Check Copilot App install; push a new commit; retry |
| `review-timeout` | `await-copilot-review` exit 124 | 0 | Re-run `/review-loop` |
| `trigger-error` | `gh` returned non-zero or 5 consecutive errors | 1 | Inspect the surfaced gh stderr |

## Error Handling Summary

| Condition | Behavior |
| --- | --- |
| Provider unresolved (`capabilities` non-zero) | Exit 1, stderr surfaced verbatim |
| No AI review bot (`aiReviewBot == false`) | Status line, then auto-route to proxy mode; exit 1 with the setup message only if `REVIEW_LOOP_DEFAULT_PROXY_BACKEND` is unset |
| A non-Copilot reviewer (`aiReviewBot == true`, no `copilot` in `aiReviewBotNames`) | Phase 1b bot-review flow — never proxy mode |
| Reviewer configured but has not posted (`check-bot-review` `present == false`) | Poll to `--wait-timeout`, then exit 0 naming the reviewer; never a silent "nothing to do" |
| No open PR | Exit 0 with message (skip) |
| Copilot unavailable | Exit 0 with message (skip) |
| Max rounds reached | Exit 0 with summary |
| Copilot posted a no-findings acknowledgment comment | Exit 0 with close-out message (Phase 3z / Auto Driver) |
| Antagonist returned malformed JSON | Exit 1, print raw output |
| `/address` failed | Exit 1, no re-trigger — round not consumed |
| Trigger ladder exhausted without engagement | Exit 1, `engagement-timeout` |
| `await-copilot-review` timeout | Exit 0, `review-timeout` |
| Persistent gh failure | Exit 1, `trigger-error` |
