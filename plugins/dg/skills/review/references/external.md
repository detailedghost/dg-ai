# External PR review (`-x` / `--external`)

Full step-by-step for reviewing a **GitHub PR** instead of a local range. Same board, same
`"$DG" viz review` + wait loop as the default mode — only the subject (a PR, not your own
working tree) and the last step (post to GitHub, not act-locally) differ.

## 1. Resolve the PR

```sh
TARGET="$1"          # PR number, full URL, or empty (bare -x)
GH_REPO="$REPO_FLAG"  # from --repo OWNER/REPO, empty if not passed

if [ -n "$TARGET" ]; then
  PR_JSON=$(gh pr view "$TARGET" ${GH_REPO:+--repo "$GH_REPO"} \
    --json number,baseRefOid,headRefOid,headRefName,url)
else
  PR_JSON=$(gh pr view ${GH_REPO:+--repo "$GH_REPO"} \
    --json number,baseRefOid,headRefOid,headRefName,url)   # defaults to current branch's PR
fi
PR_NUMBER=$(printf '%s' "$PR_JSON" | jq -r .number)
BASE_SHA=$(printf '%s' "$PR_JSON" | jq -r .baseRefOid)
HEAD_SHA=$(printf '%s' "$PR_JSON" | jq -r .headRefOid)
PR_URL=$(printf '%s' "$PR_JSON" | jq -r .url)
REPO=$(git rev-parse --show-toplevel)
```

`gh pr view` accepts a bare number or a full URL identically — no separate URL-parsing needed.
`--repo` disambiguates which GitHub repo `gh` targets; it does **not** let you review a PR outside
the repo you're standing in — `"$DG" viz review --repo <path>` needs real local git objects, so `-x`
only works on PRs against the current local clone (or a fork of it).

## 2. Make the head reachable, then render

```sh
git -C "$REPO" fetch origin "pull/$PR_NUMBER/head"     # works for fork PRs too — it's a ref on the base repo
git -C "$REPO" cat-file -e "$BASE_SHA" 2>/dev/null || git -C "$REPO" fetch origin   # base staleness fallback
```

Now `$BASE_SHA`/`$HEAD_SHA` are exactly `--base`/`--head` for `"$DG" viz review` (step 4) — no
extra ref resolution needed.

## 3. Reviewer agent → findings

Launch the `reviewer` agent ("The Nitpicker") **in the
foreground** — its findings gate the next step, so don't fan it into the background. Give it the
range and ask for its normal report *plus* one machine-readable block:

```
Review the diff between $BASE_SHA and $HEAD_SHA in the repo at $REPO (PR #$PR_NUMBER: $PR_URL).
Run `git diff $BASE_SHA..$HEAD_SHA` and give every changed file the full standards pass per your
identity — every file, not just hot spots.

Produce your normal Summary / Findings / Positive Notes report. Then append exactly one more
fenced ```json block, and nothing else json-fenced, containing every finding that anchors to a
single file+line as:
  [{"file": "relative/path", "lineNumber": <int>, "side": "old"|"new", "body": "<severity emoji> <finding text>"}]
- "side": "new" for anything on the added/context side of the diff (the common case — default to
  this), "old" only for a finding specifically about a deleted line.
- lineNumber is the diff's own numbering for that side (the number shown in that hunk of
  `git diff`) — not a guessed absolute line.
- Skip findings with no single-file/single-line anchor (architectural, cross-file, style-wide
  concerns) — leave those in prose only; they still reach the human via the review summary.
- Empty array if nothing anchors.
```

Extract the fenced ```json array from the agent's returned text — that is the whole parsing step,
no prose-scraping. Write it to a scratch file, e.g. `$("$DG" stash review x-$PR_NUMBER-comments.json)`.

## 4. Render + wait (reuses the existing machinery unchanged)

```sh
out=$("$DG" viz review --repo "$REPO" --base "$BASE_SHA" --head "$HEAD_SHA" --comments "$COMMENTS_FILE")
SLUG=$(printf '%s' "$out" | sed -n 's#.*/viz/\([^/]*\)/payload.*#\1#p')
# Launch in the BACKGROUND (Bash `run_in_background: true`); relaunch on a non-zero exit.
"$DG" viz wait "$SLUG" --resume --timeout 3600
review_result=$("$DG" viz get "$SLUG" review_result --require-fresh "$HEAD_SHA")
```

Same mandatory-wait discipline as the default mode (SKILL.md's Flow section) — a timeout is not an
exit, never fabricate a verdict. The board opens pre-filled with the agent's findings as regular,
editable/removable line comments (they're seeded through the same `addComment`/`addFileComment`
path a human click would take — no visual "AI-suggested" marker, since on a fresh board every
comment present *is* one of them until the human adds their own).

## 5. Post the verdict to GitHub

**Every verdict posts** — approve, request_changes, and comment all become a real GitHub review;
there is no "fix it yourself" loop here (that's the default mode's job, reviewing your own WIP).
Nothing reaches GitHub before this point — the wait in step 4 is the entire gate.

Field mapping, `review_result` → GitHub's `POST /pulls/{n}/reviews`:

| `review_result` | GitHub review payload | Notes |
|---|---|---|
| `verdict` | `event` | `approve→APPROVE`, `request_changes→REQUEST_CHANGES`, `comment→COMMENT` |
| `summary` | `body` (prefix) | overall comment |
| `lineComments[]` where `scope:"line"` | `comments[]` `{path, line, side, body}` | `path = file`, `line = lineNumber`, `side: "old"→"LEFT", "new"→"RIGHT"` |
| `lineComments[].startLineNumber` (if ≠ `lineNumber`) | `comments[].start_line` / `start_side` | multi-line range comment; `start_side` = same mapped side |
| `lineComments[]` where `scope:"file"` | folded into `body` | GitHub's review API has no clean anchorless-per-file slot in `comments[]` — append `**{file}:**\n{body}` after the summary instead |
| `fileApprovals[]` | *(not sent)* | board-only progress tracking (viewed state), no GitHub equivalent |

Note the schema in `references/payload-schema.md` lists a `fileApprovals[].comment` field — that
field does not actually exist in the current board implementation (`ReviewSection.astro`'s
`FileApproval` is `{path, viewed}` only). Per-file notes live in `lineComments[]` with
`scope:"file"`, mapped per the table above — treat that as the source of truth over the schema doc
for this one field until it's corrected there.

Build and send:

```sh
jq -n --arg commit "$HEAD_SHA" --arg event "$EVENT" --arg body "$BODY" --argjson comments "$COMMENTS_JSON" \
  '{commit_id: $commit, event: $event, body: $body, comments: $comments}' > review.json
gh api "repos/$OWNER/$REPO_NAME/pulls/$PR_NUMBER/reviews" --method POST --input review.json
```

`commit_id` is `$HEAD_SHA` (the PR's `headRefOid` from step 1) — not a local ref name. GitHub
requires a non-empty `body` for `REQUEST_CHANGES` and `COMMENT` events (empty is fine for
`APPROVE`); if `summary` and every file-scoped note are both empty, fall back to a minimal body
(e.g. `"Reviewed via /review -x."`) rather than let the POST 422.

**Off-by-one caveat:** `lineNumber` values came from the board's own diff parser
(`ReviewSection.astro`'s `parsePatch`), which already tracks old/new line numbers correctly through
deletions — so no adjustment is needed for comments the *human* added by clicking a rendered line.
The risk is upstream, in the reviewer agent's *own* line-number attribution when it writes the
seed JSON in step 3 (it's reasoning from `git diff` output, not clicking rendered rows) — the
prompt's "use the diff's own numbering for that side" instruction is what keeps those anchors
correct; a finding anchored to the wrong side or an absolute (non-diff-relative) line number is the
usual source of a GitHub comment landing on the wrong row.
