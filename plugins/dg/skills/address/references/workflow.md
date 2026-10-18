# Workflow

IN/OUT per phase. Gates = hard stops. Resolve `DG` using [../SKILL.md](../SKILL.md#runtime-and-skill-paths) before commands in each fresh shell.

## Phase 0 — Parse Args

OUT: `agents`, `extraContext`, `roundNumber`, `verdictsPath`, `includeCi` (default true), `localOnly` (default false).

- `-l`/`--local` → `localOnly=true`, `includeCi=false`, skip provider gathering.
- `-a <list>`, `-m "<ctx>"`, `--round N`, `--verdicts <path>`, `--no-ci`: extract as named.
- Bare args → agent list. No args → `agents=null` (auto-detect in 1b).
- `verdictsPath` set → `includeCi` defaults false.

## Phase 0.25 — Worktree Cleanup

Search `.agents/spec/*/*.md` (and legacy `.agents/create-specs/*.md`) and the durable spec/sdlc dirs for a spec whose `worktree.path == pwd` or `worktree.pr_url` matches the PR:

```sh
ls "$("$DG" stash -s spec)"/*.md "$("$DG" stash -s sdlc)"/*.md 2>/dev/null
```

`"$DG" stash -s` buckets by the **main worktree**, so it resolves the same from the worktree and from the origin repo — which is what makes step 3g below able to find what the run wrote.

Skip when: no spec has `worktree:` block; `worktree.pr_url` empty; `pr_strategy: cross-repo`.

1. `"$DG" address view-pr "$worktree.pr_url"` — prints the PR/MR as JSON on both providers. Read the normalized `.merged` boolean, not `.state`, so the same check works for a GitHub PR and a GitLab MR. A non-zero exit means the lookup failed: skip the cleanup rather than treating the failure as a state.
1. `.merged == false` → continue.
1. `.merged == true`:
   - a. `git -C "$worktree.path" status --porcelain` non-empty → print instructions, exit non-zero.
   - b. `git -C "$worktree.path" log @{u}..HEAD` non-empty → print instructions, exit non-zero. If the upstream cannot be resolved or either safety check fails, retain the worktree and report the failed check.
   - c. Honor cleanup authorization already granted in this session or `permissions.auto_cleanup_worktree=true`. Otherwise ask through the host's question facility: "PR merged. Remove worktree + branch?" → Remove (Recommended) / Keep / Abort. Keep or Abort retains the worktree.
   - c.5. Relocate the session and any active tool working directories to `worktree.origin_repo` using the host's available working-directory controls before deleting the worktree. Verify that later commands run from that surviving directory. If the host cannot safely relocate an active session, retain the worktree and report the blocker.
   - d. `git -C "$worktree.origin_repo" worktree remove "$worktree.path"`
   - e. `git -C "$worktree.origin_repo" branch -D "$worktree.branch"`
   - f. Clear `worktree.path`/`worktree.branch` in spec (preserve `pr_url`, `origin_repo`). Commit: `chore(specs): worktree cleanup for <slug> (pr <num> merged)`.
   - g. From the verified `worktree.origin_repo` working directory, remove the run's durable scratchpad — `$("$DG" stash -s spec)/<NNN>_<slug>-scratch.md` for a `/spec` run, `$("$DG" stash -s sdlc)/<slug>.md` plus `<slug>-scratch.md` for a bare `/sdlc` one (silent if absent; slug from `feature_snake_case` or derived from branch). Run `"$DG" stash -s` **after** relocating; it is keyed to the main worktree, so it is unchanged by moving out of the worktree. This is the only place these files get reaped before the 30-day TTL — merge is the right moment, since `/sdlc` finish.md's Hold-and-resume path still reads them until then. Print summary. Exit zero.

GATE: cleanup complete, deferred, or aborted.

## Phase 0.5 — Upfront Permissions

IN: `localOnly`.

Run in parallel:

1. `"$DG" address probe` — provider auth failure non-fatal when `localOnly=true`; warn and continue.
1. `dba` agent: `"Return OK"` (probes the host's configured delegation facility). Honor existing session authorization; do not add permissions.

GATE: probe fails AND `localOnly=false` → stop.

## Phase 1 — Gather

IN: `verdictsPath`, `includeCi`, `localOnly`.
OUT: `workList` tagged by `source` (`"local-review"` | `"comment"` | `"ci"`), `reviewDir`.

Always run 1c first. Run 1a+1b in parallel only when `localOnly=false`.

### 1c. Local code-review items (always)

**Resolve `reviewDir`** (the directory whose `.agents/code-review/` will be globbed):

When `localOnly=true`: `reviewDir = $PWD`.

When `localOnly=false` (PR-targeted run), resolve in order — use the first that yields a path:

1. Check specs in `.agents/spec/*/plan.md` (and legacy `.agents/create-specs/*.md`) and `$("$DG" stash -s spec)/*.md` plus `$("$DG" stash -s sdlc)/*.md` for a `worktree.path` or `worktree.pr_url` that matches the current PR (same lookup as Phase 0.25 — reuse its `"$DG" stash` snippet). If found, `reviewDir = worktree.path`.
1. Get the head branch: `"$DG" address view-pr <pr>` and read `.headRefName`. Then scan `git worktree list --porcelain` for a worktree whose checked-out branch matches. If found, `reviewDir = <that worktree path>`. Works on both providers — `headRefName` is the MR's source branch on GitLab. A non-zero exit means no match: fall through to step 3.
1. Fall back: `reviewDir = $PWD`.

De-duplicate: if `reviewDir == $PWD`, glob only once.

1. Glob `<reviewDir>/.agents/code-review/YYYY-MM-DD-HHMMSS-NNN.md`; sort lexicographically; take last. No match → `localItems=[]`.
1. Parse each distinct finding into `{localId:"local-N", source:"local-review", mode:"fix", path, line, body, severity|null, reviewFile}`. No `threadId`/`commentId`/`diffHunk`.
1. **Always print:** `[local-review] gathered N file(s) from <reviewDir>` (N=0 is fine — the log is required so a miss is visible).
1. `localOnly=true` and no file found → stop: `"--local: no code-review file found"`.

### 1a. Comment items (skip when `localOnly=true`)

- `verdictsPath` set: read `{commentId, threadId, verdict, reason}[]`; fetch context via `gather-unresolved`; merge by `commentId`. Tag `source:"comment"`.
- Otherwise: `"$DG" address gather-unresolved` → `{threadId, commentId, path, line, body, diffHunk, author, mode}[]`. Same shape on GitHub and GitLab; `diffHunk` is always `""` on GitLab, whose discussions API exposes a note's position but no hunk text. `mode="explain"` if thread contains `#explain`, else `"fix"`. Tag `source:"comment"`. On GitHub, only a thread's first 50 comments are fetched, so an `#ignore`/`#explain` marker or a bot reply landing past comment 50 is not seen.

### 1b. CI items (skip when `localOnly=true` or `includeCi=false`)

`"$DG" address gather-ci-failures` → `{ciId, source:"ci", name, conclusion, runId, jobId, workflowFile, url, logExcerpt}[]`. Same shape on GitHub Actions and GitLab pipelines. `conclusion` is lowercase (e.g. `"failure"`) on both providers — the provider-neutral contract, not GitHub's old ALL-CAPS GraphQL vocabulary (e.g. `"FAILURE"`) from the pre-migration `statusCheckRollup` call.

### 1d. Wiz items (skip when `localOnly=true`)

Wiz posts as `wiz-<id>[bot]`: a "Wiz Scan Summary" PR comment, optional inline threads, and checks named `Wiz *`.

1. Detect: comment items whose `author` matches `^wiz-.*\[bot\]$`; ci items whose `name` starts with `Wiz`; and the latest summary comment: `gh api repos/{owner}/{repo}/issues/<pr>/comments --jq '[.[]|select(.user.login|test("^wiz-.*\\[bot\\]$"))]|last|.body'`. None → skip 1d. This single native `gh` read requires the external GitHub CLI and the host's existing approval for that read. The supported DG operations do not expose issue-summary comments; keep this summary-only discovery without adding an invented DG command.
2. Use the Wiz MCP from the main loop (subagents may lack it). Load `mcp__claude_ai_Wiz__discover` / `mcp__claude_ai_Wiz__execute` via ToolSearch. Not connected → print `[wiz] MCP not connected; run /mcp → claude.ai Wiz` and handle the items from their text only.
3. For each finding, fetch details with `execute`: SAST → `codesec` `list_sast_findings` (`file_path`, `status:["OPEN"]`) or `get_sast_finding`; CVE / dependency → `vulnerabilities` domain; secret → `secrets` domain; IaC misconfiguration → `cspm` domain; failed Wiz CLI scan → `codesec` `list_cicd_scans` + `get_cicd_scan`. `discover <domain>` shows parameters.
4. Tag items `source:"wiz"` (summary-only findings) or keep `source:"comment"`/`"ci"` with `wiz:true`. Attach `{findingId, rule, severity, path, line, remediation}` from Wiz to each item.

### Merge

`workList = localItems ++ commentItems ++ ciItems ++ wizItems`.

GATE: `workList` empty → stop.

## Phase 1.55 — Apply Explanations

Skip when no comment items have `mode="explain"`.

For each: read `path`+`diffHunk` for context; compose grounded explanation (cite code, not speculation); `"$DG" address resolve-with-reply <commentId> <threadId> "<explanation>"`. Drop from `workList`.

GATE: all calls succeeded. `workList` empty after → stop.

## Phase 1.5 — Antagonist Triage

Skip when `verdictsPath` set. CI and Wiz items bypass (pass through unchanged). Local-review items ARE triaged.

Input: `source=="comment" && mode=="fix"` + all `source=="local-review"` items.

1. Normalize: `{id: commentId|localId, body, path, line}[]`.
1. Launch `copilot-antagonist`:
   > Evaluate these review findings. Return ONLY:
   > `[{"id":"<id>","verdict":"accept|reject-illogical|reject-other|strange","reason":"<why>"}]`
1. Validate all ids present + verdicts valid. Merge back by `commentId`/`localId`. Reconstitute with CI items.

GATE: every triaged item has a verdict.

## Phase 1.6 — Apply Rejections

Skip when `verdictsPath` set.

For each `reject-*` item:

- `source=="comment"`, `reject-illogical`: `"$DG" address resolve-with-reply <commentId> <threadId> "Thanks — respectfully declining. <reason>"`
- `source=="comment"`, `reject-other`: `"$DG" address resolve-with-reply <commentId> <threadId> "Thanks — declining. <reason>"`
- `source=="local-review"`: drop silently; print `[local-review] rejected: <localId> — <reason>`.

Drop all `reject-*` from `workList`.

GATE: all `resolve-with-reply` calls succeeded (local rejects never block). `workList` empty → stop.

## Phase 1b — Auto-Detect Agents

Skip if `agents` is 1–2 items. Run when null or 3+.

Launch `foreman` with `model: sonnet` (a routing pick, not a planning call):

> Return ONLY a JSON array of agent names from: `js csharp python dba security shell devops jira qa-writer lore`.
> Items: `{workList JSON}`. Route `ci` items by `workflowFile` (→ devops for `.yml`) or `logExcerpt` extension. Include `devops` when CI items exist.

Append `extraContext` if set. Parse → `agents`.

## Phase 2 — Fix

Sub-pass A (CI) then B (comments + local-review). CI first so QA has a green baseline.

### 2a. Classify

- CI → `code`.
- comment/local-review: `docs` if `*.md`, `docs/**`, or body requests only doc edits; `code` otherwise.

### 2a.5 — Strange Escalation

Runs when any item has `verdict="strange"`. the host's question facility per item (batch ≤4): show `path:line`, body, reason.

- **Accept** — keep in workList.
- **Skip** — drop, leave thread open.
- **Resolve silently** — `"$DG" address resolve-silent <threadId>` (local-review: drop only, no helper call).

GATE: no `strange` items undecided.

### 2b. Test-first (comment + local-review code items only)

Skip if no files match `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.*`, `tests/**`, `__tests__/**`.

Launch `qa-writer`:

> Write tests reproducing each issue. No production code changes.
> Items: `{workList JSON}`
> Return ONLY: `[{"id":<commentId|localId>,"tested":true|false,"reason":"<why>"}]`

### 2c. Apply Fixes

Route items per `agents.md`. Per-agent prompts:

**comment/local-review:**

> Fix these review items. Read file+context, apply changes. One entry per item — use `status:"blocked"` if stuck.
> Items: `{JSON}`
> Return ONLY: `[{"id":<commentId|localId>,"status":"fixed"|"blocked","summary":"<what/why>"}]`

**CI:**

> Fix these failing CI checks. Read `workflowFile`+`logExcerpt`, fix root cause. Do NOT disable checks.
> Items: `{JSON}`
> Return ONLY: `[{"ciId":"<id>","status":"fixed"|"blocked","summary":"<what/why>"}]`

**Wiz (`source=="wiz"` or `wiz:true`):** route by path per `agents.md`, plus `security` for secrets and CVEs.

> Fix these Wiz findings at the root cause, following the Wiz remediation. Upgrade or replace a vulnerable package, never pin a known-bad version. Remove a leaked secret from code and say it must be rotated. Never suppress a rule or add an ignore unless the item says the user approved it.
> Items: `{JSON}`
> Return ONLY: `[{"id":"<findingId|commentId|ciId>","status":"fixed"|"blocked","summary":"<what/why>"}]`

Append `extraContext` if set. Merge all into `fixResults` as `{itemId, source, status, summary}`.

## Phase 3 — QA (max 3 cycles)

Parallel: `reviewer` (quality/logic), `qa-devops` (build/tests), `qa-perf` (perf/allocs). Pass `git diff --name-only HEAD~1`; respond per `agents.md` JSON format.

`critical`/`high` items → re-route to Phase 2c. Increment cycle counter.

GATE: 3 failures → stop, report, do not commit.

## Phase 4 — Document

Skip unless `docs/**`, `*.md`, or public API signatures changed. Launch `lore` on affected files only.

## Phase 5 — Commit + Push

Commit subject:

- PR comments only → `address pr review feedback`
- CI only → `fix failing ci checks`
- Both → `address pr review feedback + ci fixes`
- Local only → `address local code review findings`
- Local + PR → `address local + pr review feedback`
- Append `(review-loop round N)` if `roundNumber` set.

`"$DG" address commit-push "<subject>\n\nCo-Authored-By: Claude <noreply@anthropic.com>"`

GATE: non-zero → stop.

## Phase 6 — Reply + Resolve

Skip for CI-only and local-only runs.

Filter `workList` to `source=="comment"`. Build batch-close payload from `fixResults` (blocked items → reply-only, leave open):

```
for item in workList where source=="comment":
  match = fixResults[source=="comment", itemId==item.commentId]
  if match.status == "blocked": reply only, leave open
  else: emit {commentId, threadId, summary: match.summary}
```

`"$DG" address batch-close '<JSON>'` → `{"total":N,"succeeded":N,"failed":0}`.

`commentId` is the original review comment. On GitHub the helper posts to
`pulls/{pr}/comments/{commentId}/replies`, verifies the response's `in_reply_to_id`, and only then resolves
`threadId`. This guarantees an immediately published inline reply; do not substitute `gh pr comment` or the
GraphQL `addPullRequestReviewThreadReply` mutation, which can leave replies in pending reviews.

GATE: invalid JSON → stop. `failed > 0` → stop.

Wiz: inline Wiz threads close like any comment item. `source=="wiz"` summary findings get no reply; Wiz re-scans on push. After the push, re-check the Wiz checks and `list_sast_findings` for the changed paths, and report any finding still open.

Fallback: individual `"$DG" address reply <comment_id> <thread_id> <body>` + `"$DG" address resolve <thread_id>` per item. Resolve only after
the reply command succeeds.

## Phase 7 — Local Review Cleanup

Runs after Phase 6 on every run (including `localOnly=true`). Skip only when Phase 1c gathered no local-review items (`localItems` empty).

Local code-review files are gitignored artifacts, so removal is a plain `rm -f` (no commit). Delete a file only once it is fully accomplished — never discard outstanding findings. Paths are absolute (`reviewDir`-rooted); never `rm` relative to `$PWD` when `reviewDir` differs.

For each distinct `reviewFile` among the gathered local-review items, classify its findings by terminal state:

- **done** — committed this run (`fixResults` entry with `status:"fixed"`), or rejected in Phase 1.6, or resolved-silently in Phase 2a.5.
- **outstanding** — any finding still `blocked` (Phase 2c/3) or `skipped` (Phase 2a.5 "Skip").

Then:

- All findings **done** → `rm -f "<reviewFile>"`. Print `[local-review] removed <reviewFile> (N finding(s) accomplished)`.
- Any **outstanding** → keep the file. Print `[local-review] kept <reviewFile> — <k> finding(s) blocked/skipped`.

If an earlier GATE stopped the run after all of a file's findings reached a terminal state (e.g. every finding rejected in Phase 1.6, or explained in Phase 1.55), run this phase for that file before exiting so accomplished files are still removed.

GATE: none — best-effort. A failed `rm` prints a warning and does not stop the run.

## Compiled Address Commands

`"$DG" address` — run through the host's existing narrow approvals, honoring already granted session permission. All replies auto-prefixed
`🤖`; idempotent. `ADDRESS_BOT_PREFIX` overrides the marker for hosts that mangle emoji — set it to
`[bot]` for a plain-ASCII fallback. Reads accept `🤖`, the override, and the legacy `[bot]`, so replies
posted before the emoji switch still register as bot replies.

Use the compiled entrypoint above for the supported address operations. Phase 1d
retains one native `gh` read for Wiz summary comments. Do not add or broaden
host approval rules.

| Subcommand | Purpose |
|---|---|
| `probe` | Verify provider + git access |
| `gather-unresolved` | Unresolved, non-ignored threads as JSON |
| `gather-ci-failures` | Failing CI checks as JSON |
| `gather` | Full PR metadata (prefer `gather-unresolved` for Phase 1) |
| `view-pr [<number\|url>]` | PR/MR metadata only — `state`, `merged`, `headRefName`. Both providers. Omit the arg for the current branch's PR |
| `reply <comment_id> <thread_id> <body> [--pr=<number>]` | Reply directly to the original review comment |
| `resolve <thread_id> [--pr=<number>]` | Resolve a thread |
| `resolve-with-reply <comment_id> <thread_id> <body> [--pr=<number>]` | Reply directly + resolve in one call |
| `resolve-silent <thread_id> [--pr=<number>]` | Resolve without reply |
| `commit-push <msg>` | Stage, commit, push |
| `batch-close <json\|-> [--pr=<number>]` | Reply + resolve all threads; returns `{total,succeeded,failed}` |
| `check-copilot` | Report Copilot availability; on GitLab returns `{available:false,reason}` |
| `check-bot-review` | Report configured reviewer presence and unresolved threads |
| `request-copilot [--method=comment\|retry-comment\|reviewer]` | Request a Copilot review (Copilot capability required) |
| `verify-copilot-engaged <pr_url> <since_iso> [--timeout=N]` | Wait for engagement; timeout exits 124 |
| `await-copilot-review <pr_url> <since_iso> [--timeout=N]` | Wait for review or no-findings acknowledgment; timeout exits 124 |
| `check-no-findings <pr_url> <since_iso>` | Inspect no-findings acknowledgments |
| `fetch-copilot-review` | Latest Copilot review and unresolved comments |
| `count-copilot-reviews` | Count Copilot reviews for round accounting |

Every row above is a subcommand of `"$DG" address`. The six Copilot-only
operations (`request-copilot`, `verify-copilot-engaged`, `await-copilot-review`,
`check-no-findings`, `fetch-copilot-review`, `count-copilot-reviews`) refuse an
unsupported provider before validating their arguments. `check-copilot` retains
its availability JSON instead. `"$DG" address batch-close -` reads its JSON payload from stdin;
its `{total,succeeded,failed}` tally includes per-item failures. For GitLab
thread mutations use `--pr=<number>` when targeting an MR other than the current
branch's MR; pass the same target to both reply and resolve.
