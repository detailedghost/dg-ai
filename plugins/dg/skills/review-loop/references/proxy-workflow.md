<!-- markdownlint-disable MD013 MD033 MD041 MD060 -->

# /review-loop Proxy-Mode Workflow

Active when `-p`/`--proxy <backend>` is passed, or when default mode
auto-routes here because the provider has no AI review bot (see
Phase 0 below). No PR, no `gh`, no GitHub Copilot — the reviewer is a
local `/proxy` backend
(`codex | copilot | pi | opencode | cortex | grok`) reviewing the current branch's
diff. Findings land in a `.agents/code-review/*.md` file and flow
through `/address`'s existing local-review path (`-l`/`--local`) —
this workflow does not re-implement triage, fix, QA, commit, or
cleanup; it only produces the file and calls `/address -l`.

Resolve `DG` from [../SKILL.md](../SKILL.md#runtime-and-skill-paths) in each fresh shell.
Each phase lists `IN:` (required state) and `OUT:` (produced state), as
in [workflow.md](workflow.md). Gates are hard stops.

## Phase 0 — Argument Parsing (shared with default mode)

Extends the default-mode Phase 0 (see [workflow.md](workflow.md#phase-0--argument-parsing));
add here rather than fork it:

- `-p <backend>` / `--proxy <backend>` → `proxyMode = true`,
  `backend = <backend>`. Reject unknown backends (must be one of
  `codex`, `copilot`, `pi`, `opencode`, `cortex`, `grok` — same set `/proxy` accepts).
- `-b <ref>` / `--base <ref>` → `baseOverride = <ref>`. Proxy mode
  only — this includes an auto-routed run, so it still applies with no
  `-p` flag on a provider with no AI review bot. Ignored (with a
  warning) only when the run stays in default (Copilot) mode.
- `-r N` / `--rounds N`, `-s`/`--single`, `-n`/`--no-retrigger`,
  `-k`/`--skip` behave exactly as in default mode.
- `-w`/`--wait-timeout` is accepted but ignored in proxy mode (no
  polling wait exists here) — print a one-line notice if passed.

This phase is also reached with no `--proxy` flag at all, when
[workflow.md](workflow.md) Phase 1's `capabilities` check auto-routes
here because the provider reports no AI review bot at all. A GitLab
project uses the Phase 1b bot-review flow only when
`VCS_GITLAB_AI_REVIEW_BOT` explicitly names a reviewer. Unset, empty, or
`none` selects this no-bot proxy route. In
that case `backend` comes from the required
`REVIEW_LOOP_DEFAULT_PROXY_BACKEND` environment variable instead of
`-p`/`--proxy`, and Phase 1 has already failed loud if that variable
was unset — everything below behaves identically once `backend` is
set, including this mode's existing local-only findings guarantee.

`maxRounds` resolution when `-r`/`--rounds` is omitted: same
`REVIEW_LOOP_MAX_ROUNDS` env var if set; otherwise default to `2` for
proxy mode.

When `skip == true`: print `review-loop: skipped` and exit 0.

## Phase 1 — Base Ref Resolution

IN: none.
OUT: `base` (git ref).

1. `baseOverride` set → `base = baseOverride`. Skip to Phase 2.
2. Otherwise reuse the fork-point formula already used by `/review`
   ([../../review/SKILL.md](../../review/SKILL.md), "Ref + repo resolution";
   if not packaged yet, resolve it from the explicitly configured personal skill root):
   `base = git merge-base HEAD "$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || git rev-parse --abbrev-ref origin/HEAD | sed 's#^origin/##')"`.
   Fall back to `origin/HEAD` if that fails.
3. **In a `/spec` worktree** (spec frontmatter has a `worktree:` block,
   or the branch is `feature/*` cut from an integration branch):
   prefer `base =` that integration/base branch — same override
   `/review` applies, for the same reason (review exactly what the
   branch added).

GATE: `base` resolves to a valid ref reachable from `HEAD`. If not,
print `review-loop: could not resolve a diff base; pass --base <ref>.`
and exit 1.

## Phase 2 — Round Counter

IN: `base`.
OUT: `roundsDone` (int), `maxRounds` (possibly clamped).

1. `roundsDone = $(git log <base>..HEAD --format=%s | grep -c '(review-loop round ')`.
   This is the proxy-mode equivalent of default mode's
   `count-copilot-reviews` — round count derived from external state
   (here, git history) rather than tracked separately. The marker is
   the same `(review-loop round N)` suffix `/address --round N`
   already appends to commits, so both modes share one convention.
2. When `noRetrigger == true` (i.e. `-n`/`--no-retrigger`):
   `maxRounds = min(maxRounds, roundsDone + 1)`.
3. When `roundsDone >= maxRounds` → print
   `review-loop: max rounds reached (N/N); stopping.` and exit 0.

GATE: `roundsDone < maxRounds`.

---

## Round Step (Phases 3–5)

One full review cycle.

IN: `base`, `backend`, `roundsDone`, `maxRounds`, `single`.
OUT: terminal (exits), or loops back to Phase 3 for the next round.

## Phase 3 — Proxy Review

IN: `base`, `backend`.
OUT: review file path (may be absent/empty on a dry round).

1. `diff = git diff <base>`. Empty diff → print
   `review-loop: no diff against <base>; nothing to review.` and exit 0
   (nothing was ever committed to review — not a round, not a
   dry-round close-out).
2. `reviewFile = .agents/code-review/<YYYY-MM-DD-HHMMSS>-<NNN>.md`
   (same naming convention `/address` Phase 1c already globs for).
3. Read [../../proxy/SKILL.md](../../proxy/SKILL.md), then invoke
   `"$DG" proxy <backend> --prompt-file <absolutePromptPath>` using its
   background and result-handling contract. Prompt: see
   [proxy-review-prompt.md](proxy-review-prompt.md) — it carries the
   diff and `reviewFile` path, and instructs the backend to write
   findings there directly (or write nothing on a clean diff).
4. Follow `/proxy`'s existing result-handling rules verbatim — do not
   reinvent them here:
   - Exit 1 with `backend`, `bin`, and `installCommand` → tell the user,
     show `installCommand`, exit 1.
     Do not fall back to another backend.
   - `exitCode != 0`, `likelyCause` `"model"`/`"effort"` → ask the user
     (through the host's question facility) retry-default / different value / abort, same
     as `/proxy` itself specifies.
   - `exitCode != 0`, `likelyCause` `"other"` → show `stderrTail` +
     `logFile`, exit 1.
   - `exitCode: 0` and the backend asks a clarifying question instead
     of reviewing → answer directly if known, else ask the user, then
     re-invoke `"$DG" proxy <backend> --resume <sessionId> --prompt-file <answerPath>`. Cap at 5 round-trips (same
     cap `/proxy` documents) before giving up and treating it as a
     dry round.

GATE: `/proxy` returned `exitCode: 0` and control reaches Phase 4, or
the workflow exited per the rules above.

## Phase 4 — Dry-Round Check

IN: `reviewFile`.
OUT: action `close-out` | `act`.

1. `reviewFile` missing, or present but contains no parseable finding
   (empty file, or an explicit "no findings" line) → action
   `close-out`.
2. Otherwise → action `act`.

### 4a. Action `close-out`

1. Print:

   ```text
   review-loop: proxy backend found nothing to flag — closing loop.
   ```

2. Delete `reviewFile` if it exists but is empty (avoid leaving a
   stray empty file for `/address`'s next unrelated `-l` run to trip
   over).
3. Exit 0. The round counter is not consumed (mirrors default mode's
   no-findings close-out — no `(review-loop round N)` marker gets
   written because `/address` never runs).

### 4b. Action `act`

Proceed to Phase 5.

GATE: one of close-out / act fired.

## Phase 5 — Hand Off to /address

IN: `reviewFile`, `roundNumber = roundsDone + 1`.
OUT: `/address` exit status.

Load [../../address/SKILL.md](../../address/SKILL.md) and invoke it through
the host's skill facility, or follow its instructions directly, with arguments
`-l --round <roundNumber>`. Resolve a missing sibling only from the explicitly
configured personal skill root.

No `--verdicts` — `/address`'s own Phase 1.5 local-review triage
handles antagonist filtering for `source: "local-review"` items; there
is no GitHub thread to reply to or resolve, so `/address` already
skips that step for this source (per its workflow, "CI and local skip
this").

`/address` commits with the `(review-loop round N)` marker Phase 2
counts on the next invocation.

GATE: `/address` returns 0.

- Non-zero → print the surfaced error and exit 1. The round does
  **not** count as consumed (no commit was made, so Phase 2's git-log
  scan won't see a new marker).
- Zero → continue to the loop decision below.

---

## Loop Decision

IN: successful Phase 5, `roundsDone`, `maxRounds`, `single`.
OUT: terminal, or restarts at Phase 3 for `roundsDone + 1`.

1. `single == true` → print:

   ```text
   review-loop: round <N> complete. Re-run /review-loop -p <backend> for the next round.
   ```

   Exit 0.
2. `roundsDone + 1 >= maxRounds` → print:

   ```text
   review-loop: final round (<N>/<maxRounds>) complete.
   ```

   Exit 0.
3. Otherwise: re-diff (`git diff <base>` against the new `HEAD` after
   `/address`'s commit) and restart at Phase 3 for the next round —
   no polling wait needed since the proxy call is synchronous from
   this workflow's point of view (it runs in the background per
   `/proxy`'s contract, but Phase 3 waits for its completion or job status).

## Failure surface

Distinct exit messages, same format as default mode's:
`review-loop: <state>: <diagnostic>`.

| State | When | Exit | Suggested next |
| --- | --- | --- | --- |
| `no-diff` | Phase 3, empty diff against base | 0 | Commit work first |
| `dry-round` | Phase 4a, backend found nothing | 0 | none |
| `backend-missing` | `"$DG" proxy` returns backend installation guidance | 1 | Install the backend, or pick another |
| `proxy-error` | `/proxy` non-zero, `likelyCause: "other"` | 1 | Inspect `stderrTail` / `logFile` |
| `address-failed` | Phase 5, `/address` non-zero | 1 | Inspect `/address`'s surfaced error |
| `max-rounds-reached` | Phase 2, `roundsDone >= maxRounds` | 0 | Raise `-r`/`--rounds` or investigate manually |
| `base-unresolved` | Phase 1, no valid base ref | 1 | Pass `-b`/`--base <ref>` explicitly |

## Error Handling Summary

| Condition | Behavior |
| --- | --- |
| No diff against base | Exit 0 with message (nothing to review) |
| Base ref unresolved and no `-b` override | Exit 1 with message |
| Backend not installed | Exit 1, show `installCommand` — no auto-switch |
| Backend review round errors (`other`) | Exit 1, show `stderrTail`/`logFile` |
| Backend finds nothing | Exit 0, dry-round close-out — round not consumed |
| `/address -l --round N` fails | Exit 1, no loop continuation — round not consumed |
| Max rounds reached | Exit 0 with summary |
