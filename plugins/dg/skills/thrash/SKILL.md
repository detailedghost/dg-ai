---
name: thrash
description: >-
  Tiered code review with a verdict. Takes a GitHub PR or GitLab MR URL and
  posts inline comments (💀 critical, 🔥 high, ⚠️ medium, 🧹 low, 🔬 nit) plus
  approve, request-changes, or comment-only. `--spice 1-5` sets how hard the
  review looks and how many findings fail it, not its tone. `--stacked` finds every open PR in the target's
  stack and reviews them all. Pass `.` or a path instead of a URL for a local
  review that writes findings for `/address -l`.
---

# /thrash

Review a diff, tier every finding, post the review with a verdict. A diff over 3000
changed lines is split into chunks, each reviewed by its own `thrash` agent in parallel
and merged into one review. Cost: a small diff still takes one agent pass; a large diff
takes one per chunk. Large diffs use up to 8 agents, and every changed line outside skipped
generated, lock, or vendored files is reviewed. All agents use the same configured `thrash` persona and
model, so cost scales with size up to 8x. One publish. The verdict posts with no confirm unless you ask for one.

## Usage

```
/thrash <pr-or-mr-url> [--stacked] [-s N] [-c] [--confirm] [-n] [-t <tier>] [--proxy <backend>]
/thrash . | <path>     [-s N] [-b <ref>] [-t <tier>] [--proxy <backend>]
```

| Flag | Meaning |
|---|---|
| `--stacked` | Review every open PR in the target's stack, root first. Any PR in the stack works as the target. |
| `-s, --spice N` | 1 to 5, default 2. Scrutiny depth, nit budget, and verdict limits. Tone never changes. |
| `-c, --comment` | Post as comment only. No approve, no request-changes. |
| `--confirm` | Confirm before posting. |
| `-n, --dry-run` | Preview only. Exports `DG_THRASH_DRY_RUN=1` for the run and calls `post --dry-run`, so nothing reaches the provider even if a step runs. |
| `-t, --min-tier <tier>` | Drop findings below this tier. Overrides the spice nit ladder. |
| `-b, --base <ref>` | Local mode only. Override fork-point detection. |
| `--proxy <backend>` | Run each chunk review on an external CLI (`codex`, `copilot`, `pi`, `opencode`, `cortex`, `grok`) through `/proxy`, in the background, briefed as the `thrash` persona. Compile, verdict and post stay the same. |

## Verdict rule

Spice sets how many findings per tier the PR can have. One more than the limit requests
changes. Otherwise approve. A blank cell has no limit.

| Spice | Critical | High | Medium | Low |
|---|---|---|---|---|
| 1 | 0 | 4 | | |
| 2 | 0 | 1 | | |
| 3 | 0 | 0 | 4 | |
| 4 | 0 | 0 | 2 | |
| 5 | 0 | 0 | 0 | 4 |

Nits never fail a review. `--comment` replaces the event. Spice never moves a tier.
`VERDICT_LIMITS` in `pkg/skills-cli/src/thrash/core.ts` owns these numbers.

## Runtime and skill paths

Resolve the compiled CLI before running any command:

```bash
DG="${DG_HOME:-$HOME/.dg}/bin/dg-skills"
dg_bootstrap() {
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
  fi
}
dg_has_thrash() {
  case "$("$DG" thrash --help 2>/dev/null)" in *--dry-run*) return 0 ;; esac
  return 1
}
if [ ! -x "$DG" ] || ! dg_has_thrash; then
  dg_bootstrap
  dg_has_thrash || { echo "dg-skills at $DG is missing thrash post --dry-run; update it with the bootstrap above" >&2; exit 1; }
fi
```

`DG_HOME` moves the whole install, binary included. A binary whose `thrash` help lacks
`--dry-run` is stale: re-bootstrap once, then stop with that error rather than run it.

Repeat this resolution in every fresh shell, including delegated execution and
resumed commands; shell variables do not persist between tool calls. Use the
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

Every provider and git call goes through `"$DG" thrash`. Its five subcommands are
`stack`, `diff`, `compile`, `post`, and `tally`. The flags above describe this
skill's orchestration: chunk scheduling and `--proxy` are handled by the calling
agent, while the helper writes the chunk plan, compiles findings, and publishes.

## Flow

1. **Diff.** `"$DG" thrash diff "$TARGET" ${BASE:+--base "$BASE"}` prints JSON with `diffPath`,
   `contextPath`, `chunks`, `skipped`, `stats`, `untracked`. Each chunk has
   `id`, `label`, `annotatedPath`, `findingsPath`. A diff at or under the threshold is
   one chunk. Zero chunks → say "nothing to review" and stop. Warn on `untracked` paths.
2. **Review.** Launch one `thrash` agent per chunk, all in one message, per
   `references/agent-prompt.md`. Each writes its `findingsPath` itself and replies with
   one `WROTE` line. Never pull its JSON into context. Never ask the user about size.
   With `--proxy <backend>`, start one background `"$DG" proxy` job per chunk instead,
   per the "Proxy backend" section of that file, and wait for every job to finish.
3. **Compile.** `"$DG" thrash compile "$TARGET" --diff "$diffPath" --spice N [--min-tier t]
   [--comment]`. It merges every chunk's findings, dedupes them, validates anchors,
   dedupes against open thrash threads, applies the nit ladder, decides the verdict, and
   prints the preview plus `REVIEW_JSON=` and `VERDICT=`. Show the preview. On a rejected
   or missing file, follow the retry in `references/agent-prompt.md`.
4. **Gate.** Local target: report `ADDRESS_FILE=` and offer `/address -l`, then stop.
   `--dry-run`: run `export DG_THRASH_DRY_RUN=1` at the start of the run (every fresh shell),
   and in step 5 call `"$DG" thrash post "$TARGET" --review "$REVIEW_JSON" --dry-run`. It prints
   the review it would post and makes no provider call; the env var makes any `post` a no-op too. Confirm through the host's user-question facility only when `--confirm` was
   passed. Otherwise go to step 5 now.
5. **Post.** `"$DG" thrash post "$TARGET" --review "$REVIEW_JSON"` (plus `--dry-run` in report-only mode) posts and saves the result
   next to the review JSON. If `degraded` is true, say the provider refused the requested
   verdict and posted as comment (for example, an own-PR restriction); the body still states the verdict.
6. **Tally.** `"$DG" thrash tally "$REVIEW_JSON"...` prints a markdown table: PR, review link,
   findings per tier, inline count, and Approve, Request changes or Comment. Show it
   verbatim as the final report.

## Large diffs

`LARGE_DIFF_LINES` (3000 changed lines) and `MAX_CHUNKS` (8) in `pkg/skills-cli/src/thrash/core.ts` own the
split. Above the threshold the helper splits by directory, then file, then hunk, and
orders chunks source, tests, docs, generated. Above the cap, neighboring chunks merge so
every file is still reviewed, and the verdict comes from the tally alone. Interactive and
headless runs behave the same: no size prompt. `references/details.md` has the rule.

## Stacked

`--stacked` runs the same steps across the stack, keeping per-PR output out of context:

1. `"$DG" thrash stack "$TARGET" --diff` walks every PR in the stack, open, merged or closed,
   root first, and prints one row per PR with `number`, `url`, `state` and `reviewed`.
   Only **open** PRs are reviewed: their rows add `diffPath`, `contextPath`, `chunks`,
   `skipped` and `changed`, and each context file lists the merged PRs as context.
   A **merged** PR is never reviewed again; its row has a `statusPath` and tally shows
   "merged (context only, not reviewed)". A **closed** unmerged PR gets the same and shows
   "closed without merging (not reviewed)". Report closed PRs to the user.
2. Launch every chunk agent of every PR in one message, or every `--proxy` job. Wait for
   all `WROTE` replies.
3. Compile every PR in one shell loop with stdout sent to `/dev/null`; errors still show.
   Each review JSON is its `diffPath` with `.diff` replaced by `.review.json`.
4. `"$DG" thrash tally` on all review files plus every `statusPath`, in stack order, is the
   preview; unposted rows say so.
   For `--dry-run`, show the unposted tally and stop. Otherwise post with no confirm,
   unless `--confirm` was passed. Then one confirm covers the stack.
5. Post in one shell loop with stdout sent to `/dev/null` (with `--dry-run` in report-only
   mode), then run `tally` again on the same files as the final report.

## Rules

- Never modify tracked files. This skill reviews, it does not fix.
- Provider writes begin at step 5. Step 4 is the whole gate: a local target
  or `--dry-run` stops there, and `--confirm` asks first. Diff size never asks.
- Do not compute the verdict yourself. `compile` owns it.
- Do not post with `gh` or `glab` directly. The helper handles both providers.

## References

| When | Read |
|---|---|
| Launching or retrying an agent, or a `--proxy` job | `references/agent-prompt.md` |
| Provider mapping, own-PR fallback, dedupe rule, local mode details, known gaps | `references/details.md` |
