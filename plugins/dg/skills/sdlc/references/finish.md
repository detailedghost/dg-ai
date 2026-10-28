# Steps 5–8 — Review, Docs, Human Gate, PR/MR

Sections 5–8 are the canon for `/dg:spec`'s execute mode too ([spec execute.md](../../spec/references/execute.md) delegates here for all of it, including step 8 — there is no separate PR-launch skill). `/dg:spec` runs step 8 with two deltas, both called out inline: the PR/MR always opens as a draft, and the URL is handed to `~/.dg/bin/dg-skills batch-open` afterward.

## Step 5 — Final review + correction

Derive the changed-file list: `git diff --name-only $(git merge-base HEAD origin/<base-branch>)`. Launch **dg:reviewer**, **dg:qa-perf**, **dg:qa-devops**, **dg:security** in parallel (template: `templates/final-review.md`). Each reads `## Issues Remediation`. **Include in the briefing:** `SPEC_PATH` + `SCRATCH_PATH` — reviewers may read the scratchpad for ephemeral context in addition to the spec's `## Agent Notes`.

> **GATE:** all reviewers reported.

### Correction (max 2 rounds total — net-new findings do NOT reset the counter)

No findings → step 6. Before routing, read Issues Remediation. Exact duplicates of already-triaged findings (same `file:line` + issue text) → skip; same root cause at a new location → treat as new. Then:

- a. Group **new** findings by slice → route to the responsible agent (template: `templates/correction.md`).
- b. Re-run only the flagging reviewers to verify. Net-new findings from re-review go to the next round, still within the 2-round cap.
- c. After round 2: CRITICAL/HIGH-security → escalate to the user. Others → `## Issues Remediation` + user ack.
- d. Commit the fixes once the round is clean (`fix(<scope>): …`).

> **GATE:** reviews clean OR max rounds + user acknowledged.

## Step 6 — Test-name gate, then docs

**Test-name gate** (`/dg:standard-test` rules 7-8). Scan committed test files for TDD-scaffolding markers — fail the gate if any test **filename** or `describe`/suite label still carries `red`/`green`/`slice-N`/plan markers (e.g. `*.red.*`, `*.green.*`, `red_*`, `green_*`). Rename/consolidate to a name that mirrors the code under test (red+green pairs merge into one committed file). A committed test that still says "red"/"green" is a review red flag — fix it before anything ships.

**Docs.** Launch **dg:lore** (template: `templates/lore.md`) on the changed-file list. Gate: no public API/function without a doc comment; README updated if the public interface changed. Commit (`docs(<scope>): …`, silent if `permissions.housekeeping_commit`). Docs run right before the human gate so the reviewer sees them in the diff.

> **GATE:** test names clean, docs committed.

## Step 7 — Human review moves to the PR/MR

The wave and final reviews in step 5 were *agent* review. The single **human** review of the whole change happens on the open PR/MR, out of band, after this run has ended. This step has no blocking gate: go straight to step 8, which opens the PR/MR as a draft. `/dg:address` collects the comments in a later session.

Nothing else relaxes. Step 5's agent reviews, step 6's test-name gate and the docs pass all still gate step 8, and a failure in any of them still stops the run before a PR/MR exists.

Because nothing has reviewed the code when the PR/MR opens, step 8 forces `--draft`. The draft state tells a reader the change is unreviewed. It is promoted to ready from the PR/MR page once the review approves.

## Step 8 — PR/MR (direct)

- a. **Push:** `git push -u origin <branch>` (silent if `permissions.git_push`).

- b. **Body:** populate the provider's template if present — `.github/PULL_REQUEST_TEMPLATE.md` on GitHub, the first `.gitlab/merge_request_templates/*.md` on GitLab; fallback sections Summary / Dev Notes / QA Notes / Risk / How to revert. A provider template that lacks Risk or How to revert gets them appended. Append `## Known Issues (Deferred)` from Issues Remediation if non-empty. End with the Claude Code attribution footer. Style: [pr-body-style.md](pr-body-style.md) — apply its self-check to the draft before step c.

- c. **Create:** run

  ```sh
  ~/.dg/bin/dg-skills vcs-provider create-pr \
    --title "<title>" --base "<base>" --head "<branch>" --body "<body>" [--draft]
  ```

  (silent if `permissions.gh_pr_create` — the key keeps its historical name and covers both hosts). It prints one JSON object; take `.url` and `.number` from it. **Never shell `gh` or `glab` here.** The provider layer is the only reason this step works on a GitLab remote at all. If it exits non-zero, report the error and stop; do not fall back to `gh`. Draft rule: **always** pass `--draft`, for every caller including `/dg:sdlc`. No human has read the code yet, and the draft state is what says so. Promote it from the PR/MR page once the review approves.

- d. **Worktree bookkeeping (`WORKTREE_MODE`):** persist the URL to `worktree.pr_url` in the ephemeral spec. There is no `ExitWorktree` call to make here: step 1 never relocates the session into the worktree (see `setup.md` Step 1), so cwd has been at `worktree.origin_repo` for the whole run — reaching the worktree's files only through the `cd`-prefixed commands step 1 describes. Do **not** remove the worktree (`/dg:address` cleans it up on detected merge). **`/dg:spec` delta:** persist to `worktree.pr_url` in the bundle's `plan.md` instead (if it carries a worktree block) — `plan.md` is the durable spec, not the ephemeral ones this step normally writes. Print: `"PR/MR opened (draft): <url>. Review it there — /dg:address picks up the comments. Worktree retained at <path>."`

- e. The ephemeral spec + scratchpad stay in `$(~/.dg/bin/dg-skills stash -s sdlc)/` — `/dg:address` removes them when the PR/MR merges (Phase 0.25 step 3g), and `/cleanup`'s 30-day walker catches any that never merge. No manual cleanup, and do **not** delete them at open: step 5's reviewers and the later `/dg:address` session still read them.

- f. **Open it:** run `~/.dg/bin/dg-skills batch-open --group open <url>` (resolve the CLI with the bootstrap block in [SKILL.md](../SKILL.md) first; the [browser skill](../../browser/SKILL.md) documents the command) so it lands grouped in the browser without a separate ask. Applies to every PR/MR this step opens, `/dg:spec` included. This is also how the human gets to the review. It is best-effort: the PR already exists, so when `batch-open` fails (for example on a CLI-only install without the extension), print the PR URL and continue.

- g. **Dependent PRs/MRs:** if this one depends on another that is still open (cross-slice, cross-spec, or cross-repo — the case `/dg:spec`'s multi-slice runs can produce, since unlike `/dg:sdlc`'s one-per-feature default they may open more than one across a bundle's lifetime), run `~/.dg/bin/dg-skills chain plan`/`~/.dg/bin/dg-skills chain apply` ([chain skill](../../chain/SKILL.md)) on the pair/chain instead of leaving them as unrelated links. The chain command resolves the provider the same way this step does. The `depends_on`/dependency-layer data already computed in `engineering.md` §4.1 plugs straight into the chain command's layer-list input with no translation needed.

> **GATE:** URL captured; in `WORKTREE_MODE`: cwd back at `origin_repo`, worktree intact. This is also where the run ends — the human review happens on the PR/MR afterward.
