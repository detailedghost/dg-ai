# Findings and summary

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

## Open findings

Only open findings count toward the verdict. A finding is open until someone fixes it (its thread is outdated and the re-review does not find it again), answers it in its thread, or resolves the thread. Clearing never resolves a thread. When no finding is open, the verdict is approve, in every round. Earlier blocking findings that are now fixed or answered do not hold it back.

## Flag details

- `--confirm`: `post` refuses an approve or request-changes event without `--confirm`.
- `--dry-run` exports `DG_THRASH_DRY_RUN=1` for the run and calls `post --dry-run`, so nothing reaches the provider even if a step runs.
- `--min-tier` overrides the spice nit ladder.
- `--improvements`: pass `IMPROVEMENTS: on` to the agents and `--improvements` to `compile`. A policy with `improvements: true` does the same.
- `--proxy`: each chunk review is briefed as the `thrash` persona. Compile, verdict and post stay the same.
- `--no-repo`: pass it to `diff` and `stack`.
