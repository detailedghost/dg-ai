# Steps 5–8 — Review, Docs, Human Gate, PR/MR

Sections 5–8 are the canon for `/spec`'s execute mode too ([spec execute.md](../../spec/references/execute.md) delegates here for all of it, including step 8 — there is no separate PR-launch skill). `/spec` runs step 8 with two deltas, both called out inline: the PR/MR always opens as a draft, and the URL is handed to `"$DG" batch-open` afterward.

`REVIEW_MODE` runs through both remaining gates. It is `pr` unless the caller passed `-l`/`--local`, and it decides only *where the human reviews* — never whether the agent reviews in step 5 or the gates in step 6 hold.

## Step 5 — Final review + correction

Derive the changed-file list: `git diff --name-only $(git merge-base HEAD origin/<base-branch>)`. Launch **reviewer**, **qa-perf**, **qa-devops**, **security** in parallel (template: `templates/final-review.md`). Each reads `## Issues Remediation`. **Include in the briefing:** `SPEC_PATH` + `SCRATCH_PATH` — reviewers may read the scratchpad for ephemeral context in addition to the spec's `## Agent Notes`.

> **GATE:** all reviewers reported.

### Correction (max 2 rounds total — net-new findings do NOT reset the counter)

No findings → step 6. Before routing, read Issues Remediation. Exact duplicates of already-triaged findings (same `file:line` + issue text) → skip; same root cause at a new location → treat as new. Then:

- a. Group **new** findings by slice → route to the responsible agent (template: `templates/correction.md`).
- b. Re-run only the flagging reviewers to verify. Net-new findings from re-review go to the next round, still within the 2-round cap.
- c. After round 2: CRITICAL/HIGH-security → escalate to the user. Others → `## Issues Remediation` + user ack.
- d. Commit the fixes once the round is clean (`fix(<scope>): …`).

> **GATE:** reviews clean OR max rounds + user acknowledged.

## Step 6 — Test-name gate, then docs

**Test-name gate** (`/standard-test` rules 7-8). Scan committed test files for TDD-scaffolding markers — fail the gate if any test **filename** or `describe`/suite label still carries `red`/`green`/`slice-N`/plan markers (e.g. `*.red.*`, `*.green.*`, `red_*`, `green_*`). Rename/consolidate to a name that mirrors the code under test (red+green pairs merge into one committed file). A committed test that still says "red"/"green" is a review red flag — fix it before anything ships.

**Docs.** Launch **lore** (template: `templates/lore.md`) on the changed-file list. Gate: no public API/function without a doc comment; README updated if the public interface changed. Commit (`docs(<scope>): …`, silent if `permissions.housekeeping_commit`). Docs run right before the human gate so the reviewer sees them in the diff.

> **GATE:** test names clean, docs committed.

## Step 7 — Human review gate (`REVIEW_MODE`)

The wave and final reviews in step 5 were *agent* review. This step is the single **human** review of the whole change. `REVIEW_MODE` decides where it happens:

| `REVIEW_MODE` | Where the human reviews | This step |
|---|---|---|
| `pr` (default) | On the open PR/MR, out of band, after this run has ended | **Skipped.** Go straight to step 8, which opens the PR/MR as a draft. |
| `local` (`-l`, `--local`) | A `/review` board on `<base>..<head>`, before anything is pushed | Runs as written below, BLOCKING. |

**In `pr` mode this run has no blocking human gate.** That is the point of the mode, not an oversight: the review moves onto the provider, where the human reads it on their own schedule and `/address` collects the comments in a later session. Nothing else relaxes — step 5's agent reviews, step 6's test-name gate and the docs pass all still gate step 8, and a failure in any of them still stops the run before a PR/MR exists.

Because nothing has reviewed the code when the PR/MR opens, step 8 forces `--draft` in this mode. The draft state is what tells a reader the change is unreviewed. It is promoted to ready from the PR/MR page once the review approves.

### `local` mode only — everything below

Once `-l` selects this mode, no permission flag bypasses the gate. Choosing where the human reviews is the caller's decision at invocation; waiving the review altogether is not something a permission grant can do.

Invoke the **`/review` skill** on `<base>..<head>` with `--spec $SPEC_PATH` — it owns the whole `review → wait → review_result` contract (ref resolution, board render, blocking re-arm loop, verdict readback) per the `/review` skill's own `SKILL.md`. Alongside the board, print a text digest (changed-file list, `## Slice Summaries`, test status, `## Issues Remediation`). **Fallback (no viz / board fails):** present the digest and ask via `AskUserQuestion` with the same three verdicts.

Route `review_result.verdict`:

- **`approve`** → step 8.
- **`request_changes`** → treat every `lineComments[]` entry (at its `file:lineNumber`) + `summary` as work items; route per step 5's correction routing; re-run affected QA; commit; **return to the top of this step** (re-render on the new range).
- **`comment`** → surface the comments and ask whether to address them (→ `request_changes`) or proceed. Never silently swallow them.
- **Hold** (board closed without submitting, or Hold in the fallback prompt) → stop without pushing; worktree + spec stay intact; print a resume hint (re-run `/sdlc` with the same slug).

Always echo the verdict + a concise digest of the comments before proceeding.

> **GATE (`local` only):** human approved the full change set.

## Step 8 — PR/MR (direct)

- a. **Push:** `git push -u origin <branch>` (silent if `permissions.git_push`).

- b. **Body:** populate the provider's template if present — `.github/PULL_REQUEST_TEMPLATE.md` on GitHub, the first `.gitlab/merge_request_templates/*.md` on GitLab; fallback sections Summary / Dev Notes / QA Notes. Append `## Known Issues (Deferred)` from Issues Remediation if non-empty. End with the Claude Code attribution footer. Style: [pr-body-style.md](pr-body-style.md) — apply its self-check to the draft before step c.

- c. **Create:** run

  ```sh
  "$DG" vcs-provider create-pr \
    --title "<title>" --base "<base>" --head "<branch>" --body "<body>" [--draft]
  ```

  (silent if `permissions.gh_pr_create` — the key keeps its historical name and covers both hosts). It prints one JSON object; take `.url` and `.number` from it. **Never shell `gh` or `glab` here.** The provider layer is the only reason this step works on a GitLab remote at all. If it exits non-zero, report the error and stop; do not fall back to `gh`. Draft rule:

  | `REVIEW_MODE` | `--draft` |
  |---|---|
  | `pr` | **Always**, for every caller including `/sdlc`. No human has read the code yet, and the draft state is what says so. Promote it from the PR/MR page once the review approves. |
  | `local` | `/sdlc`: only if the user asked. **`/spec` delta: always**, regardless — step 7's human `/review` already gated the code, so the draft window is the remaining edit space for the PR/MR message itself. |

- d. **Worktree bookkeeping (`WORKTREE_MODE`):** persist the URL to `worktree.pr_url` in the ephemeral spec. There is no `ExitWorktree` call to make here: step 1 never relocates the session into the worktree (see `setup.md` Step 1), so cwd has been at `worktree.origin_repo` for the whole run — reaching the worktree's files only through the `cd`-prefixed commands step 1 describes. Do **not** remove the worktree (`/address` cleans it up on detected merge). **`/spec` delta:** persist to `worktree.pr_url` in the bundle's `plan.md` instead (if it carries a worktree block) — `plan.md` is the durable spec, not the ephemeral ones this step normally writes. Print, by mode:

  - `pr`: `"PR/MR opened (draft): <url>. Review it there — /address picks up the comments. Worktree retained at <path>."`
  - `local`: `"PR/MR opened: <url>. Worktree retained at <path> for /address."`

- e. The ephemeral spec + scratchpad stay in `$("$DG" stash -s sdlc)/` — `/address` removes them when the PR/MR merges (Phase 0.25 step 3g), and `/cleanup`'s 30-day walker catches any that never merge. No manual cleanup, and do **not** delete them at open: step 5's reviewers, `local` mode's Hold-and-resume path, and `pr` mode's later `/address` session all still read them.

- f. **Open it:** run `"$DG" batch-open --group open <url>` (resolve the CLI with the bootstrap block in [SKILL.md](../SKILL.md) first; the [browser skill](../../browser/SKILL.md) documents the command) so it lands grouped in the browser without a separate ask. Applies to every PR/MR this step opens, `/spec` included. In `pr` mode this is also how the human gets to the review, so it is not optional there.

- g. **Dependent PRs/MRs:** if this one depends on another that is still open (cross-slice, cross-spec, or cross-repo — the case `/spec`'s multi-slice/find-work-style runs can produce, since unlike `/sdlc`'s one-per-feature default they may open more than one across a bundle's lifetime), run `"$DG" chain plan`/`"$DG" chain apply` ([chain skill](../../chain/SKILL.md)) on the pair/chain instead of leaving them as unrelated links. The chain command resolves the provider the same way this step does. The `depends_on`/dependency-layer data already computed in `engineering.md` §4.1 plugs straight into the chain command's layer-list input with no translation needed.

> **GATE:** URL captured; in `WORKTREE_MODE`: cwd back at `origin_repo`, worktree intact. In `pr` mode this is also where the run ends — the human review happens on the PR/MR afterward.
