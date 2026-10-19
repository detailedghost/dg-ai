# Step Details

Use `"$DG" deps-upgrade` for the covered operations below. Resolve `DG` with the
[skill bootstrap](../SKILL.md#runtime-and-skill-paths) in every fresh shell,
including resumed and delegated commands. Repository build/lint/test commands run
natively with normal host permissions and existing session grants. The command
auto-detects the ecosystem; pass `--ecosystem <name>` to override mixed markers.

## Step 1: Prepare

`"$DG" deps-upgrade prepare`

Fetches the default branch, then creates a dedicated worktree + branch through its internal worktree creator (`<prefix>deps_update_<ts>`, where `<prefix>` is `$DG_DEPS_BRANCH_PREFIX` and defaults to `chore/` — the `YYYYMMDD-HHMMSS` UTC slug is normalized to underscores) based on `origin/<default>`, and resets the run's scratch snapshots (`closed-prs.txt`, `audit-before.json`, `audit-after.json`, `held-by-cooldown.jsonl`). The scratch dir is anchored to the git common dir, so it stays the same after you cd into the worktree.

`prepare` prints the worktree path and branch. **`cd` into that path now** and run every remaining step from there.

> **GATE:** In the worktree, on the `<prefix>deps_update_<ts>` branch, clean working tree.

## Step 2: Discover

`"$DG" deps-upgrade list-prs` — prints JSON for open Dependabot PRs (GitHub) or Renovate MRs (GitLab).

On GitHub this is a label-based `gh` lookup (`dependencies` label). On GitLab there's no equivalent label convention, so it looks up open MRs authored by the configured Renovate bot login instead (`renovate-bot` by default, override with `AI_RENOVATE_BOT_LOGIN`) — this assumes the target repo actually runs Renovate under that login. A zero-result GitLab lookup prints a warning naming the login on stderr before falling through, since on GitLab a zero result is ambiguous between "nothing to do" and "wrong login" (a zero-result GitHub lookup is unambiguous and prints nothing).

Zero PRs → skip to Step 3 (security-only run). Note in summary.

Categorize each PR as **patch**, **minor**, or **major** from the version bump in the title.

> **GATE:** Update list exists (may be empty).

## Step 3: Security Audit

`"$DG" deps-upgrade audit` — dispatches to the right tool per ecosystem (`npm/bun/pnpm/yarn audit`, `govulncheck`, `cargo audit`, `dotnet list package --vulnerable`, `bundle audit`, `pip-audit`) and writes a JSON snapshot to `$("$DG" stash --state deps-upgrade audit-before.json)` (first call) or `$("$DG" stash --state deps-upgrade audit-after.json)` (subsequent calls) for `summary` to pick up.

For fixable vulnerabilities not covered by a Dependabot PR → add to update list. Note unfixables for the summary. Zero PRs AND zero fixable vulns → report "nothing to do" and stop.

> **GATE:** At least one update to apply.

## Step 4: Apply Updates

Apply **patch/minor** first, then **major**.

- Before each dependency bump, run `"$DG" deps-upgrade cooldown <pkg> <old> <new> --cooldown-days N` using the run's selected cooldown (default 7 days; `0` disables it). `ok` and `fallback` permit upgrading to the returned `version`; skip `held` and `unknown`. Keep skipped packages at the current version and include the summary's "Held by cooldown" list in the final report and PR body. GitHub Action refs use the workflow-specific update path below.
- Per dependency: `"$DG" deps-upgrade bump-dep <pkg> <old> <new>`. Handles manifest edit, install, `git add`, and a conventional commit. Pass `--files a,b` to stage extra files.
- Per GitHub Action: `"$DG" deps-upgrade bump-action <ref> <from> <to> [workflow-files…]`. Defaults to all `.github/workflows/*.yml` files. GitHub Actions-specific by design. With no `.github/workflows` present it exits non-zero with `no workflow files changed — check <from> tag`, so skip this step on a GitLab-only repo instead of calling it and hitting a mid-run abort.

If lockfile conflicts or install fails → resolve, re-run.

> **GATE:** Install succeeds, lockfile clean, no unresolved conflicts.

## Step 5: Fix Breaking Changes

- No major bumps → skip to Step 6.
- Major bumps:
  1. Pull the Dependabot/Renovate changelog with `"$DG" deps-upgrade pr-body <number>`. Fall back to context7 or WebSearch for deeper migration docs.
  1. Read `.agents/paths.md` (if it exists) to find source directories before grepping. Narrows the search past test fixtures, build output, `node_modules`.
  1. Grep for all usage of the bumped package within those directories.
  1. Apply minimum necessary migration changes only. The bump is already committed, so commit the migration separately: `"$DG" deps-upgrade commit chore deps "migrate <pkg> to <new>" --files <comma-separated>`.

> **GATE:** All migration changes applied.

## Step 6: Verify

1. Check `AGENTS.md`, `CLAUDE.md`, `.agents/school/infrastructure.md`, and CI workflow files for build/lint/test commands.
1. Run build → lint → test, in order (ecosystem-specific and project-scoped — the helper deliberately doesn't wrap these since they vary too much).
1. If failures → fix and re-run. Fix only what the dependency update broke.

> **GATE:** Build, lint, and test all pass.

## Step 7: Validate (optional, recommended for major bumps)

Launch in parallel if available:

- **qa-devops** — verify build is clean, no new warnings, CI pipeline valid.
- **security** — re-run `"$DG" deps-upgrade audit` and diff vulnerabilities before/after.

If findings → fix and re-verify. If agents unavailable → skip.

> **GATE:** Validation clean or skipped.

## Step 8: Commit

Commits are produced by `bump-dep` and `bump-action` directly — one per dependency, conventional format (`chore(deps): bump <pkg> from <old> to <new>`). For one-off commits outside the bump cycle (e.g. a docs change), use `"$DG" deps-upgrade commit <type> <scope> "<message>" [--files a,b]`.

Never squash — each update stays as its own commit.

> **GATE:** All committed, clean working tree.

## Step 9: Record History

1. Create `.agents/school/` if needed.

1. Read or create `.agents/school/DEPS.md`.

1. Add a run section at the top (below "Recurring Issues"):

   ```
   ## YYYY-MM-DD
   - package old -> new
   - Breaking: what broke, how fixed
   - Quirks: ecosystem workarounds
   - Unfixed: vulnerabilities still present
   ```

1. If a breaking change or quirk is likely to recur → add to "Recurring Issues".

1. Keep max 3 run sections. Delete oldest if more. Max 80 lines total.

1. Commit the update with `"$DG" deps-upgrade commit docs deps "record YYYY-MM-DD batch upgrade" --files .agents/school/DEPS.md`.

DEPS.md template:

```markdown
<!-- Dependency upgrade history. Keep recurring issues + last 3 runs. Max 80 lines. -->

## Recurring Issues

## YYYY-MM-DD
```

The history commit lands before Step 10, so `push-pr` publishes it.

## Step 10: Push & Open PR

1. Find the PR template (`.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`, `docs/pull_request_template.md`, or `.github/PULL_REQUEST_TEMPLATE/`). Populate every section (mark N/A if inapplicable).

1. If no template → fall back to:

   ```
   ## Summary
   Batch dependency upgrade — <N> packages updated, <M> security fixes.

   ## Dev Notes
   <package old -> new, one per line>

   ## QA Notes
   - Build: passing | Lint: passing | Tests: passing
   - Security audit: clean / N unfixable

   ## Misc.
   <Breaking changes / migration notes, or "None">
   <Unfixable vulnerabilities, or "None">
   ```

1. Include the `"$DG" deps-upgrade summary` "Held by cooldown" list in the PR body.

1. `"$DG" deps-upgrade push-pr "<title>"` — reads body from stdin, pushes the branch, creates a **draft** PR, prints the URL. Always omit `--ready` in this workflow.
   Title the PR `chore(deps): <description>`. Repos that enforce conventional titles allow
   `feat fix docs style refactor perf test chore ci` only; `build` is rejected. The bump commits
   use `chore(deps)` for the same reason.

1. Open the PR in the default browser, grouped into a `Deps` tab group:

   ```bash
   "$DG" batch-open --group "Deps" "<pr-url>"
   ```

   Resolve `DG` using the bootstrap in this skill's [runtime section](../SKILL.md#runtime-and-skill-paths) in this fresh shell. Browser setup is documented in the installed [browser skill](../../browser/SKILL.md); use configured personal skill roots if absent.

   **Best-effort — never fails the run.** The PR already exists by this point, and grouping needs the `dg-ai-extension` loaded in that browser profile. If the binary is missing, the bootstrap fails, or nothing opens, say so in the Step 12 summary and move on. Do not retry or troubleshoot.

## Step 10b: Ready When Green

Run `"$DG" deps-upgrade ready-when-green <pr>` after opening the draft. It polls
GitHub checks, marks the PR ready only after success, and prints JSON. With no
checks, it waits a five-minute grace period before marking ready. Report `ready`
(exit 0), `failed` (1), or `timeout` (2); a failure or timeout leaves the draft in
place. Options: `--repo owner/name`, `--timeout-minutes N`, and
`--interval-seconds N`. This verb uses GitHub checks; on GitLab, use the host's
native MR pipeline/status workflow and approval rules before marking ready.

## Step 11: Close Dependabot/Renovate PRs

Run this only after Step 10 returned the PR URL, so a failed push never leaves the originals closed without a replacement.

`"$DG" deps-upgrade close-prs <n> [<n>…]`

Closes each PR/MR with the standard comment (referencing the current deps-update branch) and appends to `$("$DG" stash --state deps-upgrade closed-prs.txt)` so `summary` can list them. If a PR's update was skipped or failed → do NOT close it. Note in summary.

> **GATE:** Applicable PRs closed.

## Step 12: Summary

`"$DG" deps-upgrade summary`

Prints a markdown run report: detected ecosystem, branch, applied counts (dependencies vs. GitHub Actions), commits since main, closed PR numbers, and vulnerabilities-before-vs-after pulled from the audit JSON snapshots. Relay it to the user as the final message.
