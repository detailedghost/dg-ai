---
name: deps-upgrade
description: Create a dedicated worktree on a timestamped branch, apply all open dependency updates from Dependabot PRs (GitHub) or Renovate MRs (GitLab), fix security vulnerabilities, fix build/lint/test issues, close the source PRs/MRs, and open a combined PR/MR.
---

# Skill: Dependency Upgrade

Batch-apply all open Dependabot PRs (GitHub) or Renovate MRs (GitLab) into a single branch, fix security vulnerabilities, resolve breaking changes, verify the project builds/lints/tests, and open one combined PR/MR.

**Usage:** `/dg:deps-upgrade [--cooldown-days N]` — only upgrade to versions published at least N days ago (default 7, `0` turns it off). Pass the same N to every `cooldown` call.

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--cooldown-days N` | none | Only upgrade to versions published at least N days ago. `0` turns the cooldown off. | `7` |

**Keep it light.** Each step is mechanical. Do not over-explain, do not speculate, do not refactor unrelated code. Read only the files you need. Produce minimal diffs.

Before starting, read these reference files:

- [references/steps.md](references/steps.md) — Full step details and gate conditions
- [references/ecosystems.md](references/ecosystems.md) — Ecosystem detection table and audit commands
- Run `~/.dg/bin/dg-skills deps-upgrade --help` for the complete command inventory.

## Runtime and skill paths

Resolve the compiled CLI before running any command:

```bash
~/.dg/bin/dg-skills deps-upgrade --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor deps-upgrade batch-open proxy stash.

Repeat this resolution in every fresh shell, resumed step and delegated command;
shell variables do not persist between tool calls. Use the host's existing narrow
approvals and honor permission already granted in this session. The compiled
binary does not grant blanket permission to its operations. Do not edit permission
files or installed plugin caches to add commands.

Resolve other skills from this installed tree (`../<skill>/SKILL.md`), or an
explicitly configured `DG_PERSONAL_SKILLS_DIR/<skill>/SKILL.md` when absent here.
Resolve delegates through the host registry or configured `DG_PERSONAS_DIR` /
`DG_AGENTS_DIR`; pass real absolute instruction paths. Report missing instructions.
The plugin ships its personas in `agents/` (Claude Code loads them as
`dg:<name>`; `dg-skills proxy` embeds them), so use those when the host has none.
Provider authentication and registry credentials use the host's existing setup;
never embed credentials in commands, reports or repository files.

## GitLab

On GitLab, `list-prs`/`close-prs`/`push-pr`/`pr-body` go through the shared VCS provider layer instead of `gh`. `list-prs` looks up open MRs authored by the configured Renovate bot login (`renovate-bot` by default, override with `AI_RENOVATE_BOT_LOGIN`) — this assumes the target repo actually runs Renovate under that login; a zero-result lookup prints a warning rather than silently reporting nothing to do. Step 4's `bump-action` remains GitHub Actions-specific by design (it only bumps `.github/workflows/*.yml` refs). On a repo with no `.github/workflows`, it exits non-zero with `no workflow files changed — check <from> tag` rather than skipping quietly, so do not call it on a GitLab-only repo. That guard is deliberate: exiting zero on no matches would hide a mistyped `<from>` tag on GitHub.

Read `.agents/school/DEPS.md` before Step 1 for past upgrade notes (recurring issues, recent runs).

## Step Overview

| # | Step | `~/.dg/bin/dg-skills deps-upgrade` subcommand | Gate |
|---|------|------|------|
| 1 | **Prepare** — Fetch default branch, create worktree + `<prefix>deps_update_<ts>` branch (prefix: `$DG_DEPS_BRANCH_PREFIX`, default `chore/`), then `cd` into it | `prepare` | In the worktree on the deps-update branch, clean tree |
| 2 | **Discover** — List open Dependabot PRs (GitHub) or Renovate MRs (GitLab), categorize by severity | `list-prs` | Update list exists (may be empty) |
| 3 | **Security Audit** — Run ecosystem audit, find fixable vulns | `audit` | At least one update to apply |
| 4 | **Apply Updates** — Check each target with `cooldown <pkg> <old> <new> --cooldown-days N` first; bump to the verdict's `version` (`ok`/`fallback`), skip `held`/`unknown`. Update manifests, clean lockfile | `cooldown`, `bump-dep`, `bump-action` | Install succeeds, lockfile clean |
| 5 | **Fix Breaking Changes** — Migrate for major bumps | `pr-body <n>` for changelogs; commit migrated files via `commit chore deps "<msg>" --files …` | Migration changes applied |
| 6 | **Verify** — Build, lint, test (all must pass) | *native project build/lint/test commands* | All green |
| 7 | **Validate** — Optional qa-devops + security re-audit | `audit` again | Clean or skipped |
| 8 | **Commit** — One commit per dependency, conventional format | covered by `bump-dep` / `bump-action`; `commit <type> <scope> "<msg>"` for one-offs | All committed, clean tree |
| 9 | **Record History** — Update `.agents/school/DEPS.md` | `commit docs deps "…"` | History updated |
| 10 | **Push & PR** — Push branch, **always** open combined PR **as a draft**, then open it in the browser. Put the `summary` "Held by cooldown" list in the body | `push-pr "<title>"` (body on stdin), then best-effort `~/.dg/bin/dg-skills batch-open` | PR URL returned |
| 10b | **Ready When Green** — Wait for CI, then mark the PR ready. A repo with no CI is marked ready after a 5 min grace period | `ready-when-green <pr>` | JSON `ready` (exit 0), `failed` (1) or `timeout` (2); report it |
| 11 | **Close PRs** — After the PR URL exists, close Dependabot PRs with comment | `close-prs <n>…` | Applicable PRs closed |
| 12 | **Summary** — Emit end-of-run report | `summary` | Markdown report printed |

## General Rules

- **Work from the worktree.** `prepare` creates a dedicated worktree through its internal worktree creator and prints its path. `cd` into that path and run every remaining step — bumps, build/lint/test, commits, push, PR — from there. Steps run outside the worktree land on the wrong branch.
- **Use `~/.dg/bin/dg-skills deps-upgrade` for covered operations.** Run repository-specific build, lint, and test commands natively under normal host permissions. If another operation is needed, use its installed skill or native tooling with the host's existing approval rules; do not modify installed caches to extend this command.
- **Speed over thoroughness.** Mechanical task. Read only what you need.
- **Minimal diffs.** Change only what the dependency update requires.
- **One thing at a time.** Patch -> minor -> major. Fix breakage before moving on.
- **Stop early if nothing to do.** Zero PRs + zero vulnerabilities = report and exit.
- NEVER skip a gate condition.
- **Opening the PR is a mandatory final step, not optional.** This skill's job is to land the batch as a combined PR (see the skill description). Once verify (Step 6) is green, record history (Step 9), then run Step 10 to push and open the PR before finishing. Surfacing it in the browser is best-effort and never fails the run.
- **Never upgrade blind.** A package held by the cooldown or with an unknown publish age stays on its current version and is listed under "Held by cooldown" in the summary and PR body.
- **Always end the run with `~/.dg/bin/dg-skills deps-upgrade summary`** so the user sees a consistent report.
