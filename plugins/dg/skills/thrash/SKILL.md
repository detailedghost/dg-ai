---
name: thrash
description: >-
  Tiered code review with a verdict. Takes a GitHub PR or GitLab MR URL, posts
  inline comments (💀 critical, 🔥 high, ⚠️ medium, 🧹 low, 🔬 nit) and a
  verdict: approve, request-changes, or comment-only. `--spice 1-5` sets depth
  and verdict limits, not tone. `--stacked` reviews a whole stack. Pass `.` or a
  path for a local review that feeds `/dg:address -l`.
---

# /dg:thrash

Review a diff, tier every finding, post the review with a verdict. With a code tree, one
`dg:thrash` agent reviews each bundle, verifiers check the findings, and one consolidator
merges the bundles. Every changed line outside skipped generated, lock,
or vendored files is reviewed.

Cost: one sonnet reviewer for each bundle (8 at most), one opus verifier for each task
(16 at most), one opus consolidator for many bundles. An approve or
request-changes event posts only after a confirm and `post --confirm`.

## Usage

**Usage:** `/dg:thrash <pr-or-mr-url> [--stacked] [-s N] [-c] [--confirm] [-n] [-t <tier>] [--improvements] [--no-repo] [--proxy <backend>]` · `/dg:thrash . | <path> [-s N] [-b <ref>] [-t <tier>] [--improvements] [--no-repo] [--proxy <backend>]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--stacked` | none | Review every open PR in the stack, root first. | off |
| `--spice N` | `-s` | 1 to 5. Depth, nit budget, verdict limits. Tone never changes. | `2` |
| `--comment` | `-c` | Post as comment only. No approve, no request-changes. | off |
| `--confirm` | none | Confirm before posting any review. An approve or request-changes event always needs one. | off |
| `--dry-run` | `-n` | Preview only. Nothing reaches the provider. | off |
| `--min-tier <tier>` | `-t` | Post no comments below this tier. Dropped findings still count toward the verdict. | spice ladder |
| `--improvements` | none | Also post up to 3 optional improvement ideas (💡). They never count toward the verdict. | off |
| `--base <ref>` | `-b` | Local mode only. Override the fork point. | detected fork point |
| `--no-repo` | none | Skip the code checkout. Reviewers see the diff only, and verify and consolidate do not run. | off |
| `--proxy <backend>` | none | Run each chunk review on an external CLI (`codex`, `copilot`, `pi`, `opencode`, `grok`) through `/dg:proxy`, in the background. It always passes `--no-repo`. | off (host agents) |

## Verdict rule

Spice sets how many findings per tier the PR can have. One more requests changes.
Otherwise approve. Only open findings count. Nits, pre-existing findings and
improvements never count. `--comment` replaces the event. The limit table and
`VERDICT_LIMITS` are in `references/verdict.md`.

## Runtime and skill paths

First run: the block installs a missing CLI and prints an upgrade hint for an old one.

```bash
{ dg thrash --help 2>/dev/null | grep -q triage &&
  dg bg --help >/dev/null 2>&1; } ||
  { "${DG_HOME:-$HOME/.local}/bin/dg" thrash --help 2>/dev/null | grep -q triage &&
  "${DG_HOME:-$HOME/.local}/bin/dg" bg --help >/dev/null 2>&1; } ||
  { { dg --version >/dev/null 2>&1 || "${DG_HOME:-$HOME/.local}/bin/dg" --version >/dev/null 2>&1; } && echo "run dg upgrade"; } ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Call `dg` in every later step. If `dg` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg` instead. If the block prints "run dg upgrade", run `dg upgrade`, then run the step again.

If a step fails, run dg doctor bg proxy thrash.

A binary whose `thrash` help lacks `triage` is stale: re-run the bootstrap once, then stop with an error.

Use the host's narrow approvals and never edit permission files. Cross-skill paths and persona lookup: `references/runtime.md`.

## Helper

Limits: `TINY_DIFF_LINES` (100) is one bundle, `BUNDLE_TARGET_LINES` (400) splits a concern, `MAX_CHUNKS` (8) caps bundles, `VERIFY_TASK_CAP` (16) findings reach verifiers, `LARGE_DIFF_LINES` (3000) splits with no git tree. No size prompt. See `references/details.md`.

Every provider and git call goes through `dg thrash`. Its seven subcommands are
`stack`, `diff`, `investigate`, `triage`, `compile`, `post`, and `tally`. Run `thrash diff` and `thrash stack --diff` with a
Bash timeout of 600000 ms (a checkout can pass 120 s).

## Flow

`references/flow.md` has the full text of every step.

1. **Diff.** `dg thrash diff "$TARGET" ${BASE:+--base "$BASE"}` (add `--no-repo` for `--no-repo` or `--proxy`). Zero chunks: say "nothing to review" and stop.
2. **Review.** One `dg:thrash` agent for each `chunks[]` entry (`agent-prompt.md`), in waves. With `--proxy`, one background `dg proxy` job each. With no `repo` or `repo.source` `none`, skip 3 to 6.
3. **Triage merge.** `dg thrash triage --stage merge --diff "$diffPath" --spice N`.
4. **Verify.** One `dg:thrash-verify` agent for each `tasks[]` entry, in waves.
5. **Triage apply.** `dg thrash triage --stage apply --diff "$diffPath"`.
6. **Consolidate.** One `dg:thrash-consolidate` agent, only with more than one `chunks[]` entry.
7. **Compile.** `dg thrash compile "$TARGET" --diff "$diffPath" --spice N` plus the flags in `references/flow.md`. Show the preview.
8. **Gate.** Local target: report `ADDRESS_FILE=`, offer `/dg:address -l`, stop. `--dry-run`: export `DG_THRASH_DRY_RUN=1` in every shell, call `post --dry-run`. Confirm first for `--confirm` or approve or request changes.
9. **Post.** `dg thrash post "$TARGET" --review "$REVIEW_JSON"` (`--confirm` for an approve or request-changes verdict).
10. **Tally.** `dg thrash tally "$REVIEW_JSON"...`. Show it verbatim as the final report.

## Nested run

Use this rule when the host has no agent-launch tool (a subagent), or when `dg:thrash-verify` or
`dg:thrash-consolidate` is not registered. Pick the first path that works.

1. Read the persona file from the plugin `agents/` folder (`thrash-verify.md` or
   `thrash-consolidate.md`). Then run the stage in this agent, one item at a time, with the same
   inputs and outputs as the persona prompt.
2. Route the stage through `dg proxy codex --subagent thrash-verify|thrash-consolidate`, or
   through the `--proxy` backend when the run has one.

Triage, verify, apply, consolidate and compile never get skipped. If no path works, stop and print
`thrash cannot run nested here: <reason>; run /dg:thrash . from the main loop`.

## Waves

Launch 16 agents at most in one message. Start the next wave when every agent of the wave has
replied. A wave holds agents of one stage only, also in `--stacked` runs.

**Headless rule.** With no user to ask (for example `claude -p` or the channel-review
daemon), start every host agent of a wave in the foreground, all in one message. `--proxy` jobs
are background processes and stay outside this rule.

## Findings and summary

`references/findings.md` lists the finding rules. The summary reads: tally line, Important round note, Note, Tip and Warning callouts, then Cleared and Pre-existing bullets.

## Stacked

`--stacked` runs the same steps across the stack, each PR with its own `REPO`. Shell loops run only `dg thrash` commands: `triage --stage merge`, one `dg:thrash-verify` pass for all PRs, `triage --stage apply`, consolidate, compile, then a `post --dry-run` or post loop. Merged and closed PRs are context only. `references/stacked.md` has the nine steps.

## Rules

- Never modify tracked files. This skill reviews only.
- Provider writes begin at the Post step. The Gate step is the whole gate. Diff size never asks.
- Do not compute the verdict yourself. `compile` owns it.
- Do not post with `gh` or `glab` directly.
- Never start a second checkout. A `NO_REPO` reply or a missing tree leaves the finding unverified.
- The verifier and the consolidator never edit `REPO`.

## References

| When | Read, in `references/` |
|---|---|
| Launching or retrying an agent or `--proxy` job | `agent-prompt.md` |
| Provider mapping, own-PR fallback, dedupe, local mode, headless CI flags, known gaps | `details.md` |
| Step text, findings, stacked, verdict table, paths | `flow.md`, `findings.md`, `stacked.md`, `verdict.md`, `runtime.md` |
