# Phase Details

## Phase 0 — Preflight

1. Verify inside a git repository: `git rev-parse --is-inside-work-tree`. Capture `ORIGIN_REPO=$(git rev-parse --show-toplevel)`.
1. Detect GitHub or GitLab and verify its CLI is authenticated: `~/.dg/bin/dg-skills vcs-provider detect`, then `~/.dg/bin/dg-skills vcs-provider auth`.
1. Detect default branch: `git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@.*/@@'`. Fallback: try `main`, then `master`.
1. Fetch latest: `git fetch origin`.
1. Verify clean working tree: `git status --porcelain`. Warn if dirty — worktrees branch from HEAD.

> **GATE:** In a git repo, detected VCS provider authenticated, default branch known, origin fetched.

## Phase 1 — Discover

Discovery runs as a background **Workflow** (`references/discover.workflow.mjs`) — invoking `/dg:find-work` is the opt-in. Load `references/discovery-prompts.md`, build the `scanners[]` array from these four sources, and pass it in:

| key | Source | Max items | agentType |
|-----|--------|-----------|-----------|
| vcs-issues | `~/.dg/bin/dg-skills vcs-provider list-issues` — small/medium scope | 3 | Explore |
| code-quality | TODO/FIXME, lint, skipped tests, oversized functions | 3 | dg:reviewer |
| pr-backlog | Open PRs with unresolved review comments | 3 | Explore |
| codebase-scan | reviewer pass on recently-changed files | 3 | dg:reviewer |

```
Workflow({
  scriptPath: "<skill-dir>/references/discover.workflow.mjs",
  args: { scanners: [{ key, agentType, prompt }, ...] }   // prompts from discovery-prompts.md
})
```

`<skill-dir>` is this skill's base directory. Scanners run on `model: "haiku"` (set in-script) and return JSON arrays via a forced schema — no prose. The script then does the deterministic **merge → dedup (by `id` or `file:line`) → composite-score (effort 40% / impact 40% / recency 20%) → top 5** in-process (0 agent tokens) and returns `{ items }`. The scoring weights live in the script; don't re-derive them here.

If `items` is empty: report "No actionable work items found — the codebase looks clean." and **stop**.

> **GATE:** 1–5 ranked items available.

**→ `/compact` now.** Drop `discovery-prompts.md` from context — it is no longer needed.

## Phase 2 — Select

### 2a. Present items

Display the full ranked list (all 5 if available) as a numbered summary with source, title, effort, and description.

Then use `AskUserQuestion` with `multiSelect: true`:

- **Options**: top 4 items. Label format: `[source] title`. Description: effort + 1-sentence context.
- If a 5th item exists, mention it in the question text: "5th item: <title> — select Other to include it."
- Question: "Which items should I work on?"

### 2b. Jira follow-up

After selection, ask ONE follow-up via `AskUserQuestion`:

- Question: "Link a Jira ticket to any of these PRs?"
- Options:
  - `Skip` — No Jira linking.
  - `Enter ticket IDs` — User provides ticket IDs (comma-separated, mapped to items by selection order).

### 2c. Create tasks

`TaskCreate` for each selected item. Initial status: `pending`.

> **GATE:** At least 1 item selected. Tasks created.

**→ `/compact` now.** Shed Phase 1 results and selection context before loading the execution template.

## Phase 3 — Execute

Load `references/execution-template.md`.

### 3a. Per-item worktree setup

For each selected item, **before launching the agent**:

1. Slugify the item title: lowercase, non-alnum → `_`, trim, max 40 chars. Example: `"Fix null check in auth"` → `fix_null_check_in_auth`.
2. Create the worktree and branch from the origin default branch. The `find-work-` prefix marks origin so cleanup tooling can identify the branches:

```sh
cd "$ORIGIN_REPO" && eval "$(~/.dg/bin/dg-skills worktree create "$slug" --prefix feature/find-work- --base "$DEFAULT_BRANCH" --no-resume)"
```

3. If the command exits non-zero because the branch or path already exists, append a short numeric suffix (`_2`, `_3`, …) to the slug and run it again until it succeeds. No prompts — /dg:find-work is fire-and-forget.
4. The command sets `WORKTREE_PATH` and `WORKTREE_BRANCH`. Keep them as the item's `worktreePath` and `branch` for the per-item template substitution below.

### 3b. Launch agents (Workflow)

Execution runs as a background **Workflow** (`references/execute.workflow.mjs`). Read `references/execution-template.md` once, pass its body raw as `template`, and pass one entry per selected item — the script fills `{PLACEHOLDER}` tokens and dispatches all items concurrently (`model: "sonnet"`, set in-script):

```
Workflow({
  scriptPath: "<skill-dir>/references/execute.workflow.mjs",
  args: {
    template,                      // execution-template.md body, raw
    items: [{ title, source, id, description, file, line, jira,
              defaultBranch, worktreePath, branch }, ...]
  }
})
```

Pass `worktreePath` + `branch` from 3a. The agent's Step 0 is `cd $worktreePath`.

`TaskUpdate` each item to `in_progress` before the call. The workflow returns `{ results: [{ item, status, branch, pr_body_draft, summary, error }] }` via a forced schema — no prose to strip.

### Worktree agent lifecycle

Each agent is self-contained (see execution-template.md for full prompt). The orchestrator does NOT need to track intermediate steps — only the final JSON result matters.

**Retain only these fields from each agent's return:**

- `status`, `branch`, `pr_body_draft`, `summary`, `error`

Discard `tests` detail unless `status` is `partial` (then note failure count in summary).

### Error handling

| Situation | Agent action |
|-----------|-------------|
| Cannot determine fix | Return `{status: "failed", error: "Insufficient context"}`. No guessing. |
| Tests fail after 2 retries | Commit passing code, note failures in PR body → `{status: "partial"}` |
| Build broken | Attempt fix once. Still broken → `{status: "failed", error: "Build failure: ..."}` |
| Push rejected | Return `{status: "failed", error: "Push rejected: ..."}` with branch name |
| PR creation fails (orchestrator, after Phase 3.5) | Report the branch name so the user can create the PR manually |

### Task updates

As each agent returns:

- `success` → `TaskUpdate` to `completed`
- `partial` → `TaskUpdate` to `completed` with note about test failures
- `failed` → `TaskUpdate` to `completed` with error summary

> **GATE:** All agents have returned (success, partial, or failed).

## Phase 3.5 — Human Review Gate

**This gate is unconditional — it always runs before any PR is opened.**

Present a consolidated table of all non-failed items:

| Item | Branch | Summary |
|------|--------|---------|
| Fix null check in auth | feature/find-work-fix_null_check_in_auth | Fixed nil dereference in token validation |
| Add missing parser test | feature/find-work-add_missing_parser_test | Added coverage for edge case in CSV parser |

Then ask via `AskUserQuestion` (single-select):

- **Question:** "Review complete — open PRs for these items?"
- **Options:**
  - *Open all* — create a draft PR for every non-failed item
  - *Choose* — multiSelect follow-up: pick which branches get a PR
  - *Hold* — stop without opening any PRs; print branch names so the user can open them manually

If *Choose*: follow up with a second `AskUserQuestion` (`multiSelect: true`) listing each non-failed item by title. Only selected items proceed to PR creation.

For each approved item, run `~/.dg/bin/dg-skills vcs-provider create-pr --draft --head <branch> --base <default-branch> --title "<item title>" --body "<pr_body_draft>"`.

If the human flags that two or more approved items actually depend on each other
(rare — items normally branch independently off default), run the `/dg:chain` skill on
that subset instead of opening them as unrelated PRs: `~/.dg/bin/dg-skills chain plan <branches...>`
folded into the drafts shown above, then `~/.dg/bin/dg-skills chain apply <branches...>` after this same
approval.

> **GATE:** User reviewed the full result set. PRs opened only for explicitly approved items.

## Phase 4 — Report

Build a **compact** summary — no verbose agent output, just the table:

| Item | Status | PR |
|------|--------|----|
| Fix null check in auth | done | #42 |
| Add missing parser test | partial (tests failing) | #43 |
| Resolve PR #12 review | failed (insufficient context) | — |
| Add logging hook | held (not approved) | — |

List PR/MR URLs for easy clicking. Note failed items with one-line error reason. Note held items as "held — open manually with `~/.dg/bin/dg-skills vcs-provider create-pr --draft --head <branch> ...`".

Also list each item's worktree path so the user can find them. Worktrees are **retained** — review-comment rounds (`/dg:address`) and post-merge cleanup happen there. Cleanup: `~/.dg/bin/dg-skills worktree remove <slug>`; pass `--merged-ok` once the provider confirms the merge.

> **GATE:** Summary delivered to user.
