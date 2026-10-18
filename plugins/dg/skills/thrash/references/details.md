# Details

## Provider mapping

`postReview` in the repository's `pkg/skills-cli/src/provider/` accepts one
compiled review and handles the provider-specific publishing requests.

| Verdict | GitHub | GitLab |
|---|---|---|
| request_changes | one review, `event: REQUEST_CHANGES` | draft notes, then `bulk_publish` with `reviewer_state: requested_changes` |
| approve | `event: APPROVE` | `bulk_publish` with `reviewer_state: reviewed`, then `POST .../approve` |
| comment | `event: COMMENT` | `bulk_publish` with no `reviewer_state` |

GitHub reviews pin to the PR's head commit at post time. GitLab positions carry the MR's
`diff_refs` SHAs. Both providers reject a comment on a line outside the diff, so `compile`
resolves every anchor against the parsed hunks first and moves misses into the body.

## Own-PR fallback

GitHub refuses approve and request-changes from the PR author. The adapter retries as
comment and returns `degraded: true`. GitLab may refuse approve when author approval is
off; the drafts and summary still publish, and the result is `degraded: true`. The body
always states the verdict, so the reader still sees it.

## Dedupe rule

Before posting, `compile` lists open threads on the PR. A new comment is dropped when an
unresolved thread sits on the same path and line and its first comment starts with a
thrash tier emoji. Dropped duplicates still count in the tally and the verdict.

## Nit ladder and `--min-tier`

Spice 1 posts no nits, 2 up to 5, 3 up to 10, 4 up to 20, 5 posts all. Overflow becomes a
"Folded nits" list in the body. `--min-tier` replaces the ladder: `--min-tier nit` at
spice 1 posts every nit, `--min-tier medium` at spice 5 posts none.

## Splitting a large diff

`planChunks` in `pkg/skills-cli/src/thrash/core.ts` runs only when changed lines exceed `LARGE_DIFF_LINES`.

- Files are sorted by path, then grouped by top-level directory. A directory over the
  limit splits into its subdirectories, then into single files. Neighbors pack into a
  chunk in path order until the limit, so related files stay together.
- A file is cut by hunks only when it alone exceeds the limit. A single hunk over the
  limit is cut by lines.
- Files fall into four categories: source, tests, docs, generated. Chunks hold one
  category until the cap forces a merge. Tests, docs, and generated match by path patterns in `pkg/skills-cli/src/thrash/core.ts`.
- Chunks run source, tests, docs, generated. Generated, lock, and vendored files fill at
  most one chunk; the rest are `skipped` and named in the summary.
- At most `MAX_CHUNKS` chunks run. When the plan has more, the cheapest neighboring pair
  merges, same category first, until the count fits. A merged chunk can pass the limit.
  Every non-skipped file is reviewed, and the verdict comes from the tally alone.

`diff` writes `<slug>.plan.json` next to the diff. `compile` reads it, requires a
findings file for every reviewed chunk, merges them, and drops a finding that repeats the
same path, line, side, and text, keeping the higher tier. The merged set then gets the
usual tally, verdict, nit ladder, and thread dedupe. The body gains a "Review coverage"
section that lists the chunks.

## Local mode

`.` or a path resolves the repo root, then diffs the working tree against the fork point
(merge-base with the upstream or default branch, `--base` to override), scoped to the
path. Untracked files are skipped and listed. The same split and merge apply. `compile` writes
`<root>/.agents/code-review/YYYY-MM-DD-HHMMSS-NNN.md` in the shape `/address -l` parses,
with tiers mapped to its severities: critical and high → high, medium → medium, low and
nit → low. Unanchored findings are terminal-only in this mode. Nothing posts.

## Known gaps

- The review body uses `> [!NOTE]`-style alerts and `<span title>` hover text. Both are
  checked against GitHub's renderer only. GitLab rendering is untested.
- GitLab adapter behavior is verified against fixtures. A live MR run requires an
  installed, authenticated `glab`; see https://gitlab.com/gitlab-org/cli.
- A GitLab `bulk_publish` with zero draft notes and a `reviewer_state` is untested live.
- `resolveBaseSha` in `pkg/skills-cli/src/utils/git.ts` prefixes its divergence warning with `meaningful:`.
  The warning is correct; only the prefix is borrowed.
- The host `/review -x` workflow is outside this migration; it may still use a raw
  `gh api` recipe. Check that installed skill before invoking its publish path.
