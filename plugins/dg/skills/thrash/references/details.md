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
resolves every anchor against the parsed hunks first. A finding whose line misses the diff
posts as a file-level comment on its file: on GitHub a `subjectType: FILE` thread added to a
pending review, which is then submitted; on GitLab a draft note with `position_type: file`.
A finding that names no file in the diff is not posted. It still counts in the tally, and
the body says how many were not posted. The body lists no findings; every posted finding is
a direct comment. GitHub allows one pending review per user per PR, so `post` deletes a
stale pending review left by a killed run and tries once more.

## Own-PR fallback

GitHub refuses approve and request-changes from the PR author. It also refuses approve
from a `GITHUB_TOKEN` when the repo does not let GitHub Actions approve pull requests. The
adapter retries both as comment and returns `degraded: true`. GitLab may refuse approve when author approval is
off; the drafts and summary still publish, and the result is `degraded: true`. The body
always states the verdict, so the reader still sees it.

## Dedupe rule

Before posting, `compile` lists every thread on the PR, resolved ones included. A thread is
thrash's when its first comment starts with a thrash tier emoji, and, with `--reviewer
<login>`, when that login opened it. A new comment is dropped as a duplicate when an
unresolved thrash thread sits on the same path and line. A Medium, Low or Nit comment is also
dropped when only resolved thrash threads sit there; a Critical or High comment posts again.
Dropped duplicates still count in the tally and the verdict, except under `--policy` (below).

## Nit ladder and `--min-tier`

Spice 1 posts no nits, 2 up to 5, 3 up to 10, 4 up to 20, 5 posts all. Overflow is not
posted; the nit count in the body shows how many folded. `--min-tier` replaces the ladder: `--min-tier nit` at
spice 1 posts every nit, `--min-tier medium` at spice 5 posts none. `--min-tier` only
changes which comments post. Every finding, posted or dropped, still counts in the tally
and the verdict.

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
usual tally, verdict, nit ladder, and thread dedupe. The body does not list the chunks.

`plan.json` stores the context, annotated and findings paths relative to its own folder,
and `compile` resolves them against the folder that holds the plan. A copied scratch
folder therefore compiles from its own findings. A stored path that escapes the folder
(`..` or an absolute path elsewhere) is refused. An older plan with absolute paths still
works while those paths sit inside its folder; otherwise `compile` asks you to run `diff` again.

## Report-only (`--dry-run`)

`post --dry-run`, or `DG_THRASH_DRY_RUN=1` (also `true` or `yes`) in the environment,
prints `{ dryRun: true, url, requestedVerdict, review }` and returns. It does not detect
the provider, call `gh` or `glab`, or write `.posted.json`. It still refuses a local target
and a review compiled for another URL. Because it skips provider detection, a URL on an
unsupported host previews cleanly even though a real `post` would fail. `/dg:thrash -n` exports the variable at the start of the
run and passes the flag, so report-only is safe even when a step runs by mistake.

## Stacks with merged or closed PRs

`stack` lists open PRs, adds the target if it is not open, then, for each base branch no
candidate owns, asks for PRs of any state with that head branch, until no base is left.
It never asks about the default branch, so a merged main-to-release PR cannot become the root of every stack.
It never lists the repository's whole PR history. PRs join by head and base branch; when
a branch name was reused, the open PR owns it, else the newest. A closed PR is found when
it sits on the chain's base side; closed PRs branching off an open one are not searched. Only open PRs get a diff and a
review. A merged PR is never reviewed again: it stays in the stack as context, each open
PR's context file lists it under "Merged earlier in this stack", and its `statusPath`
tallies as "merged (context only, not reviewed)". A closed unmerged PR tallies as
"closed without merging (not reviewed)". GitHub and GitLab behave the same.

## Local mode

`.` or a path resolves the repo root, then diffs the working tree against the fork point
(merge-base with the upstream or default branch, `--base` to override), scoped to the
path. Untracked files are skipped and listed. The same split and merge apply. `compile` writes
`<root>/.agents/code-review/YYYY-MM-DD-HHMMSS-NNN.md` in the shape `/dg:address -l` parses,
with tiers mapped to its severities: critical and high → high, medium → medium, low and
nit → low. A file-level finding gets a `## path (whole file)` section. A finding with no file
in the diff is terminal-only in this mode. Nothing posts.

## Headless options for a CI runner

`compile` takes these extra flags, for a runner such as a GitHub Action:

| Flag | Effect |
|---|---|
| `--heading <text>` | Starts the summary with `## <text>` in place of `## Thrash review` and the spice. A hidden `<!-- dg:thrash-review -->` tag stays at the end, so the stale-pending-review cleanup still knows the review. |
| `--round N` | Adds `**Round:** N` to the summary, and picks the policy phase. The caller counts its own earlier reviews. |
| `--policy <file>` | YAML verdict rules in place of the spice table (example below). The verdict counts the new findings plus every open earlier thrash finding (not resolved, no reply from someone else), and a re-found open finding counts once. |
| `--max-comments N` | Posts at most N inline comments, highest tier first. The rest are listed in the summary and still count. Overrides the policy's `maxComments`. |
| `--max-event <event>` | The highest event the review may submit: `auto` (default), `approve`, `request-changes` or `comment`. A verdict above it posts as a comment, and the reason says so. |
| `--reviewer <login>` | Only threads this login opened count as thrash's, for dedupe and for open findings. A trailing `[bot]` is ignored. |
| `--sass` | Adds one line from the fixed list in `thrash/sass.ts` to the summary, picked from the verdict and the highest tier, seeded by the PR number and round. Never in an inline comment. It changes no verdict or tier. |

`THRASH_EXECUTION_CONTEXT={"origin":"action"}` labels the trigger "Automatic (GitHub Action)".

`dg-skills thrash action prepare|review|publish` runs these steps for the Thrashley GitHub Action. It reads its
inputs from `THRASHLEY_*` variables, counts rounds from the bot's own reviews, reads the rules doc and policy from
the PR's base commit, and runs one `proxy` job per chunk with `DG_PROXY_NO_SHELL=1`. State passes between phases in
`$THRASHLEY_WORK/state.json`.

A policy file:

```yaml
maxComments: 10
phases:
  - name: strict
    through: 3
    block: { critical: 0, high: 0, medium: 0, low: 4 }
  - name: relaxed
    requiresClear: [critical, high]
    nits: false
    block: { critical: 0, high: 1 }
```

Each `block` entry is the count a tier may reach; one more requests changes. A missing tier
has no limit. A round uses the first phase whose `through` covers it, or the last phase. A
phase whose `requiresClear` tiers still have an open earlier finding is not entered, so the
round stays in the phase before it. `nits: false` posts no nits.

`DG_PROXY_NO_SHELL=1` makes `dg-skills proxy copilot` deny shell, URL and built-in MCP tools,
so a reviewed diff cannot steer the agent into running commands. Other backends refuse to run
with it set.

## Known gaps

- The review body uses `> [!NOTE]`-style alerts and `<span title>` hover text. Both are
  checked against GitHub's renderer only. GitLab rendering is untested.
- GitLab adapter behavior is verified against fixtures. A live MR run requires an
  installed, authenticated `glab`; see https://gitlab.com/gitlab-org/cli.
- A GitLab `bulk_publish` with zero draft notes and a `reviewer_state` is untested live.
