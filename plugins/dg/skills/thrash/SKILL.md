---
name: thrash
description: >-
  Tiered code review with a verdict. Takes a GitHub PR or GitLab MR URL and
  posts inline comments (💀 critical, 🔥 high, ⚠️ medium, 🧹 low, 🔬 nit) plus
  approve, request-changes, or comment-only. `--spice 1-5` sets how hard the
  review looks and how many findings fail it, not its tone. `--stacked` finds every open PR in the target's
  stack and reviews them all. Pass `.` or a path instead of a URL for a local
  review that writes findings for `/dg:address -l`.
---

# /dg:thrash

Review a diff, tier every finding, post the review with a verdict. With a code tree, the
helper checks out the PR and gives each concern its own bundle. Each bundle is reviewed by
its own `dg:thrash` agent in parallel. Verifier agents then check the findings against the
tree, and one consolidator merges the bundles. Every changed line outside skipped generated,
lock, or vendored files is reviewed.

Cost: one sonnet reviewer for each bundle (8 at most), one opus verifier for each verify
task (16 at most for a review), and one opus consolidator when the review has more than one
bundle. One publish. An approve or request-changes event posts only after a confirm and `post --confirm`. A comment-only review posts with no confirm.

## Usage

```
/dg:thrash <pr-or-mr-url> [--stacked] [-s N] [-c] [--confirm] [-n] [-t <tier>] [--improvements] [--no-repo] [--proxy <backend>]
/dg:thrash . | <path>     [-s N] [-b <ref>] [-t <tier>] [--improvements] [--no-repo] [--proxy <backend>]
```

**Usage:** `/dg:thrash <pr-or-mr-url> [--stacked] [-s N] [-c] [--confirm] [-n] [-t <tier>] [--improvements] [--no-repo] [--proxy <backend>]` · `/dg:thrash . | <path> [-s N] [-b <ref>] [-t <tier>] [--improvements] [--no-repo] [--proxy <backend>]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--stacked` | none | Review every open PR in the target's stack, root first. Any PR in the stack works as the target. | off |
| `--spice N` | `-s` | 1 to 5. Scrutiny depth, nit budget, and verdict limits. Tone never changes. | `2` |
| `--comment` | `-c` | Post as comment only. No approve, no request-changes. | off |
| `--confirm` | none | Confirm before posting any review. An approve or request-changes event always needs a confirm, because `post` refuses it without `--confirm`. | off |
| `--dry-run` | `-n` | Preview only. Exports `DG_THRASH_DRY_RUN=1` for the run and calls `post --dry-run`, so nothing reaches the provider even if a step runs. | off |
| `--min-tier <tier>` | `-t` | Post no comments below this tier. Overrides the spice nit ladder. Dropped findings still count toward the verdict. | spice ladder |
| `--improvements` | none | Also post up to 3 optional improvement ideas (💡). They never count toward the verdict. Pass `IMPROVEMENTS: on` to the agents and `--improvements` to `compile`. A policy with `improvements: true` does the same. | off |
| `--base <ref>` | `-b` | Local mode only. Override fork-point detection. | detected fork point |
| `--no-repo` | none | Skip the code checkout. Reviewers see the diff only, and verify and consolidate do not run. Pass it to `diff` and `stack`. | off |
| `--proxy <backend>` | none | Run each chunk review on an external CLI (`codex`, `copilot`, `pi`, `opencode`, `grok`) through `/dg:proxy`, in the background, briefed as the `thrash` persona. It always passes `--no-repo`. Compile, verdict and post stay the same. | off (host agents) |

## Verdict rule

Spice sets how many findings per tier the PR can have. One more than the limit requests
changes. Otherwise approve. A blank cell has no limit.

Only open findings count. A finding is open until someone fixes it (its thread is outdated
and the re-review does not find it again), answers it in its thread, or resolves the thread.
Clearing never resolves a thread. When no finding is open, the verdict is approve, in every
round. Earlier blocking findings that are now fixed or answered do not hold it back.

| Spice | Critical | High | Medium | Low |
|---|---|---|---|---|
| 1 | 0 | 4 | | |
| 2 | 0 | 1 | | |
| 3 | 0 | 0 | 4 | |
| 4 | 0 | 0 | 2 | |
| 5 | 0 | 0 | 0 | 4 |

Nits never fail a review. Pre-existing findings and improvements never count either.
`--comment` replaces the event. Spice never moves a tier.
`VERDICT_LIMITS` in `pkg/skills-cli/src/thrash/core.ts` owns these numbers.

## Runtime and skill paths

First run: install or refresh the compiled CLI when it is missing or too old.

```bash
{ dg-skills thrash --help 2>/dev/null | grep -q triage &&
  dg-skills bg --help >/dev/null 2>&1; } ||
  { "${DG_HOME:-$HOME/.local}/bin/dg-skills" thrash --help 2>/dev/null | grep -q triage &&
  "${DG_HOME:-$HOME/.local}/bin/dg-skills" bg --help >/dev/null 2>&1; } ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Call `dg-skills` in every later step. If a bare name does not answer, also after the bootstrap, call it by its `${DG_HOME:-$HOME/.local}/bin` path instead.

If a step fails, run dg-skills doctor bg proxy thrash.

A binary whose `thrash` help lacks `triage` is stale: re-run the bootstrap once, then stop with an error rather than run it.

Every call works alone in a fresh shell, including delegated execution and
resumed commands. Use the
host's existing narrow approvals for the specific operation and honor permission
already granted in this session. Do not edit permission files or assume that the
compiled binary grants blanket approval to its subcommands.

Resolve cross-skill instructions from this installed tree: `../proxy/SKILL.md`
and `../address/SKILL.md` from this directory, `../../<skill>/SKILL.md` from
`references/`. An explicitly configured `DG_PERSONAL_SKILLS_DIR` may supply an
unmigrated skill. Pass real absolute paths to delegates and report missing
instructions. Resolve the `thrash` persona through the host's configured registry
or `DG_PERSONAS_DIR` / `DG_AGENTS_DIR`; never assume a private agent directory.
The plugin ships its personas in `agents/` (Claude Code loads them as
`dg:<name>`; `dg-skills proxy` embeds them), so use those when the host has none.

## Helper

Every provider and git call goes through `dg-skills thrash`. Its seven subcommands are
`stack`, `diff`, `investigate`, `triage`, `compile`, `post`, and `tally`. The flags above
describe this skill's orchestration: wave scheduling and `--proxy` are handled by the
calling agent, while the helper checks out the tree, writes the chunk plan and verify
tasks, compiles findings, and publishes. Run `thrash diff` and `thrash stack --diff` with a
Bash timeout of 600000 ms: one PR can use 120 s for the checkout and 60 s for `investigate`,
which is more than the default of 120 s.

## Flow

1. **Diff.** `dg-skills thrash diff "$TARGET" ${BASE:+--base "$BASE"}` (add `--no-repo` with `--no-repo` or
   `--proxy`) prints JSON with `diffPath`, `contextPath`, `chunks`, `skipped`, `stats`,
   `untracked`, and `repo` (`root`, `headSha`, `source`). Each chunk has `id`, `label`,
   `annotatedPath`, `findingsPath`, and, with a code tree, `bundle` and `contextPath`. A
   chunk `contextPath` is the bundle context file. The top-level `contextPath` is the
   review context file. A git tree with 100 changed lines or fewer is one bundle. Zero
   chunks: say "nothing to review" and stop. Warn on `untracked` paths.
   From round 2 the diff is only what changed since the bot's last review, and the JSON adds
   `reReview` (`sha`, `files`, `lines`). It falls back to the full PR diff when that commit is
   gone or not an ancestor of the head.
2. **Review.** Launch one `dg:thrash` agent for each `chunks[]` entry (a bundle), per
   `references/agent-prompt.md`, with `REPO` and that bundle's `BUNDLE` path. `REPO` is `repo.root`
   from the `diff` stdout, and `BUNDLE` is the chunk `contextPath`. With `repo.source`
   `api`, the prompt has `REPO`, `REPO_PARTIAL: yes` and no `BUNDLE`. Launch in waves. Each agent
   writes its `findingsPath` itself and replies with one `WROTE` line. Never pull its JSON into
   context. Never ask the user about size. With `--proxy <backend>`, start one background
   `dg-skills proxy` job per chunk instead, per the "Proxy backend" section of that file, and wait
   for every job to finish.
   When the plan has no `repo` key, or `repo.source` is `none`, launch reviewers with no `REPO`
   and no `BUNDLE`, and skip triage, verify and consolidate: go to Compile.
3. **Triage merge.** `dg-skills thrash triage --stage merge --diff "$diffPath" --spice N` prints
   `mergedPath`, `tasksPath`, `tasks` (`id`, `taskPath`, `verdictPath`) and `overCap`.
4. **Verify.** Launch one `dg:thrash-verify` agent for each `tasks[]` entry, with `TASK` set to the
   entry `taskPath` and `VERDICT_PATH` to its `verdictPath`, plus `REPO`. With `repo.source` `api`
   the prompt also has `REPO_PARTIAL: yes`. Launch in waves. A reply `NO_REPO <id>` or a missing
   tree leaves the finding unverified. Never start a second checkout, and never resume a verifier.
5. **Triage apply.** `dg-skills thrash triage --stage apply --diff "$diffPath"` collects the verdict
   files and prints `consolidateInputPath`, `consolidatedPath`, and the counts `confirmed`,
   `adjusted`, `rejected` and `unverified`.
6. **Consolidate.** Run only when the plan has more than one `chunks[]` entry. Launch one
   `dg:thrash-consolidate` agent with `CONSOLIDATE_INPUT`, `CONTEXT` and `OUTPUT_PATH` set to the
   `consolidatedPath`. A review with one entry goes from apply to compile.
7. **Compile.** `dg-skills thrash compile "$TARGET" --diff "$diffPath" --spice N [--min-tier t]
   [--comment] [--improvements] [--head-sha <pr-head-sha>]`. It reads the consolidated file, then
   the consolidate input, then the chunk files. It merges the findings, dedupes them, validates
   anchors, dedupes against earlier thrash threads, clears fixed and answered ones from the tally,
   applies the nit ladder, decides the verdict, and prints the preview plus `REVIEW_JSON=` and
   `VERDICT=`. Show the preview. On a rejected or missing file, follow the retry in
   `references/agent-prompt.md`.
8. **Gate.** Local target: report `ADDRESS_FILE=` and offer `/dg:address -l`, then stop.
   `--dry-run`: run `export DG_THRASH_DRY_RUN=1` at the start of the run (every fresh shell),
   and in the Post step call `dg-skills thrash post "$TARGET" --review "$REVIEW_JSON" --dry-run`. It prints
   the review it would post and makes no provider call; the env var makes any `post` a no-op too. Confirm through the host's user-question facility when `--confirm` was
   passed or when the verdict is approve or request changes. A headless run with no user to ask (for example the channel-review daemon) treats its own request as the confirm. A comment-only review goes to the Post step now.
9. **Post.** `dg-skills thrash post "$TARGET" --review "$REVIEW_JSON"` (plus `--confirm` for an approve or request-changes verdict, or `--dry-run` in report-only mode) posts and saves the result
   next to the review JSON. `post` removes the scratch tree. If `degraded` is true, say the provider refused the requested
   verdict and posted as comment (for example, an own-PR restriction); the body still states the verdict.
10. **Tally.** `dg-skills thrash tally "$REVIEW_JSON"...` prints a markdown table: PR, review link,
    findings per tier, comment count (line and file), and Approve, Request changes or Comment. Show it
    verbatim as the final report.

## Waves

Launch 16 agents at most in one message. Start the next wave when every agent of the wave has
replied. A wave holds agents of one stage only. The rule covers reviewers, verifiers,
consolidators and `--stacked` runs.

**Headless rule.** In a run with no user to ask, for example `claude -p` or the channel-review
daemon, start every host agent of a wave in the foreground, all in one message. `--proxy` jobs
are background processes, and this rule does not cover them.

## Findings and summary

A finding can carry more than a tier. `references/details.md` has the full rules.

- **Bug class.** One inline comment on the first copy, with a "Same class (name) at: file:line" line. The Warning callout lists each class with its places.
- **Pre-existing.** The diff did not cause it. It is marked, never counts toward the verdict, and is listed in the summary.
- **Security.** The persona's checklist tags findings `"tag": "security"`. The tag shows after the tier.
- **Improvement (💡).** Opt-in, not a tier. At most 3 per review. Never counts, never holds a thread open.
- **Evidence.** A finding checked against the tree lists the code that it read as an evidence line under the comment.
- **Diff-only.** With no tree (`--no-repo`, `--proxy`, or `repo.source` `none`), a note says the review saw the diff only.
- **Unverified.** The note `<N> findings not verified.` counts the findings that no verifier checked: no verdict file, a `NO_REPO` reply, or past the limit of 16.
- **Rejected.** The note `<N> findings rejected on verification.` counts the findings that a verifier rejected. They post no comment.
- **Cleared.** A thread cleared by a reply is "answered". An outdated thread whose finding the re-review does not find again is "fixed in `sha`". Same file plus the same class or title key means the same finding. A grouped class clears only when every file it names is in the reviewed diff. A cleared thread is remembered in the review body, so a later delta does not reopen it.
- **Re-review.** The Note callout says "Only the diff since `sha`: N files, M lines." when the review used the diff since the last review. It falls back to the full diff when a thread lookup fails or a blocker went unposted.
- **Repeated class.** A class that came up in 3 or more of the last 10 merged PRs adds a hint to consider a rule in `docs/code_review.md` or a lint check. A failed history read skips it.
- **Round note.** After round `reconsiderAfter` (policy, default 3) with a blocker still open, an Important callout says so. The verdict does not change.

The summary reads in this order: tally line (counts, round, verdict), the Important round
note, then the Note, Tip and Warning callouts, then the Cleared and Pre-existing bullets.

## Large diffs

With a git tree, a diff of 100 changed lines or fewer is one bundle (`TINY_DIFF_LINES` (100)).
Above that, the helper gives each concern its own bundle and splits a concern over the target of
`BUNDLE_TARGET_LINES` (400) changed lines. It keeps `MAX_CHUNKS` (8) bundles at most, and the limit
of 8 wins over the target. Triage sends `VERIFY_TASK_CAP` (16) findings at most to verifiers.
With no git tree, the rule of `LARGE_DIFF_LINES` (3000 changed lines) stays: above the threshold the
helper splits by directory, then file, then hunk, and orders chunks source, tests, docs, generated.
`MAX_CHUNKS` (8) in `pkg/skills-cli/src/thrash/core.ts` caps that split too: above the cap, neighboring
chunks merge so every file is still reviewed, and the verdict comes from the tally alone.
Interactive and headless runs behave the same: no size prompt. `references/details.md` has the rule.

## Stacked

`--stacked` runs the same steps across the stack, keeping per-PR output out of context. Each launch
prompt gets the `REPO` of its own PR: the `repo.root` of that PR's row. Each shell loop runs only
`dg-skills thrash` commands. Skip steps 3 to 6 for a PR whose row has no `repo` or whose
`repo.source` is `none`, and for the whole stack with `--no-repo` or `--proxy`.

1. `dg-skills thrash stack "$TARGET" --diff` (Bash timeout 600000 ms) walks every PR in the stack, open, merged or closed,
   root first, and prints one row per PR with `number`, `url`, `state` and `reviewed`.
   Only **open** PRs are reviewed: their rows add `diffPath`, `contextPath`, `chunks`,
   `skipped`, `changed` and `repo`, and each context file lists the merged PRs as context.
   A **merged** PR is never reviewed again; its row has a `statusPath` and tally shows
   "merged (context only, not reviewed)". A **closed** unmerged PR gets the same and shows
   "closed without merging (not reviewed)". Report closed PRs to the user.
2. Launch the reviewers of every PR in waves of 16 or fewer, or every `--proxy` job. Wait for
   all `WROTE` replies.
3. Run `triage --stage merge` for each PR in one shell loop, with stdout sent to a file for each PR.
   Read `tasks[]` from those files.
4. One verify pass for all PRs: launch one `dg:thrash-verify` agent for each task, in waves of 16 or
   fewer.
5. Run `triage --stage apply` for each PR in one shell loop.
6. Launch one `dg:thrash-consolidate` agent for each PR with more than one `chunks[]` entry, also in
   waves.
7. Compile every PR in one shell loop with stdout sent to `/dev/null`; errors still show.
   Each review JSON is its `diffPath` with `.diff` replaced by `.review.json`.
8. `dg-skills thrash tally` on all review files plus every `statusPath`, in stack order, is the
   preview; unposted rows say so.
   For `--dry-run`, run the `post --dry-run` loop so each scratch tree is removed, show the unposted
   tally and stop. Otherwise one confirm covers the stack when any review approves or requests changes, or when `--confirm` was passed. Pass `--confirm` to each such post.
9. Post in one shell loop with stdout sent to `/dev/null` (with `--dry-run` in report-only
   mode), then run `tally` again on the same files as the final report.

## Rules

- Never modify tracked files. This skill reviews, it does not fix.
- Provider writes begin at the Post step. The Gate step is the whole gate: a local target
  or `--dry-run` stops there, and `--confirm` or an approve or request-changes verdict asks first. Diff size never asks.
- Do not compute the verdict yourself. `compile` owns it.
- Do not post with `gh` or `glab` directly. The helper handles both providers.
- Never start a second checkout. A `NO_REPO` reply or a missing tree leaves the finding unverified.
- The verifier and the consolidator never edit `REPO`.

## References

| When | Read |
|---|---|
| Launching or retrying an agent, or a `--proxy` job | `references/agent-prompt.md` |
| Provider mapping, own-PR fallback, dedupe rule, local mode details, headless CI flags and policy files, known gaps | `references/details.md` |
