# Flow

1. **Diff.** `dg thrash diff "$TARGET" ${BASE:+--base "$BASE"}` (add `--no-repo` with `--no-repo` or
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
   `dg proxy` job per chunk instead, per the "Proxy backend" section of that file, and wait
   for every job to finish.
   When the plan has no `repo` key, or `repo.source` is `none`, launch reviewers with no `REPO`
   and no `BUNDLE`, and skip triage, verify and consolidate: go to Compile.
3. **Triage merge.** `dg thrash triage --stage merge --diff "$diffPath" --spice N` prints
   `mergedPath`, `tasksPath`, `tasks` (`id`, `taskPath`, `verdictPath`) and `overCap`.
4. **Verify.** Launch one `dg:thrash-verify` agent for each `tasks[]` entry, with `TASK` set to the
   entry `taskPath` and `VERDICT_PATH` to its `verdictPath`, plus `REPO`. With `repo.source` `api`
   the prompt also has `REPO_PARTIAL: yes`. Launch in waves. A reply `NO_REPO <id>` or a missing
   tree leaves the finding unverified. Never start a second checkout, and never resume a verifier.
5. **Triage apply.** `dg thrash triage --stage apply --diff "$diffPath"` collects the verdict
   files and prints `consolidateInputPath`, `consolidatedPath`, and the counts `confirmed`,
   `adjusted`, `rejected` and `unverified`.
6. **Consolidate.** Run only when the plan has more than one `chunks[]` entry. Launch one
   `dg:thrash-consolidate` agent with `CONSOLIDATE_INPUT`, `CONTEXT` and `OUTPUT_PATH` set to the
   `consolidatedPath`. A review with one entry goes from apply to compile.
7. **Compile.** `dg thrash compile "$TARGET" --diff "$diffPath" --spice N [--min-tier t]
   [--comment] [--improvements] [--head-sha <pr-head-sha>]`. It reads the consolidated file, then
   the consolidate input, then the chunk files. It merges the findings, dedupes them, validates
   anchors, dedupes against earlier thrash threads, clears fixed and answered ones from the tally,
   applies the nit ladder, decides the verdict, and prints the preview plus `REVIEW_JSON=` and
   `VERDICT=`. Show the preview. On a rejected or missing file, follow the retry in
   `references/agent-prompt.md`.
8. **Gate.** Local target: report `ADDRESS_FILE=` and offer `/dg:address -l`, then stop.
   `--dry-run`: run `export DG_THRASH_DRY_RUN=1` at the start of the run (every fresh shell),
   and in the Post step call `dg thrash post "$TARGET" --review "$REVIEW_JSON" --dry-run`. It prints
   the review it would post and makes no provider call; the env var makes any `post` a no-op too. Confirm through the host's user-question facility when `--confirm` was
   passed or when the verdict is approve or request changes. A headless run with no user to ask (for example the channel-review daemon) treats its own request as the confirm. A comment-only review goes to the Post step now.
9. **Post.** `dg thrash post "$TARGET" --review "$REVIEW_JSON"` (plus `--confirm` for an approve or request-changes verdict, or `--dry-run` in report-only mode) posts and saves the result
   next to the review JSON. `post` removes the scratch tree. If `degraded` is true, say the provider refused the requested
   verdict and posted as comment (for example, an own-PR restriction); the body still states the verdict.
10. **Tally.** `dg thrash tally "$REVIEW_JSON"...` prints a markdown table: PR, review link,
    findings per tier, comment count (line and file), and Approve, Request changes or Comment. Show it
    verbatim as the final report.
