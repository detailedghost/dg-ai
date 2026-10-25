---
name: test-live
description: Temporarily deploy the current feature branch to dev, stage, or prod, wait for it to go live, then cleanly drop the temp commits.
---

# test-live — Live Branch Testing

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal installed path:

```bash
~/.dg/bin/dg-skills test-live --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.20.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor test-live.

**Usage:** `~/.dg/bin/dg-skills test-live setup [dev|stage|prod]` (env defaults to `dev`) and `~/.dg/bin/dg-skills test-live cleanup`

GitHub only; there is no GitLab port. Hard stops: on `main`/`master`, or no `.github/workflows/` in the current directory.

## Phase 1 — Deploy

```bash
~/.dg/bin/dg-skills test-live setup [dev|stage|prod]
```

Patches the target deploy workflow with `workflow_dispatch` (skipped when already present), dispatches it on the current branch, waits for the run to go live, then exits 0 and prints the GitHub Actions run URL.

On success:
1. Tell the user: press Enter, or say so, when done testing.
2. Relay the printed run URL if the user needs it.

A second `setup` call on a branch that already has a pending patch refuses and names `cleanup`, instead of creating a second patch commit.

## Phase 2 — Cleanup

After the user confirms done:

```bash
~/.dg/bin/dg-skills test-live cleanup
```

Removes exactly the one commit `setup` made, preserving any later commits on the branch, then force-pushes with `--force-with-lease`. State is scoped to this repository and branch, so `cleanup` must run from the same branch `setup` patched.

## On failure

If `setup` fails after the patch commit landed, the commit is local and recorded, even when the push or dispatch itself failed. Run `cleanup` to drop it; `cleanup` is safe to call after a failed `setup`.

If `cleanup` refuses because of uncommitted changes, commit or stash them first — `cleanup` never discards unrelated work.

## Repo-local overrides

Override workflow-file discovery per environment with `.claude/test-live.conf` in the target repo: `KEY=relative/path` lines, blank lines and `#` comments ignored, for example `dev=.github/workflows/deploy.yml`.
