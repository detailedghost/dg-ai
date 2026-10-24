---
name: catchup
description: Fetch the latest origin default branch, rebase the current branch, verify build and tests, and push with force-with-lease. Investigate conflicts and verification failures.
---

# catchup — Rebase on Latest Main

Fetch origin's latest default branch, rebase the current branch onto it, verify
the build and tests, and push the rewritten branch with `--force-with-lease`.
Invoke `/dg:catchup`; pass `--no-push` to skip publishing. `--push` remains a
compatibility option, and the last push option wins.

**Usage:** `/dg:catchup [--no-push | --push]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--no-push` | none | Rebase and verify, then stop without publishing. | off |
| `--push` | none | Publish with `--force-with-lease` after verification. Kept for compatibility. | on |


## Runtime

Resolve the compiled CLI in every fresh shell, delegated execution, and resumed
command. Shell variables do not persist between tool calls:

```bash
~/.dg/bin/dg-skills catchup --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.19.1/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
~/.dg/bin/dg-skills catchup
```

If a step fails, run ~/.dg/bin/dg-skills doctor catchup.

For a local-only catchup, use `~/.dg/bin/dg-skills catchup --no-push` after the same resolution.
`~/.dg/bin/dg-skills catchup --help` prints usage without inspecting Git or running build tools.
Run from the intended repository or worktree.

Honor the host's existing narrow approvals and permissions already granted in
this session for the requested operation. Do not edit permission files or treat
the compiled binary as a blanket grant for other commands. When an operation
needs approval, use the host's approval facility with the concrete action and
reason; reuse existing authorization for that action.

## Execution

The command stashes staged or modified tracked files, leaving untracked-only
work untouched. It detects the default branch from origin's symbolic HEAD,
falling back to `origin/main` and then `origin/master`, fetches it, and reports
incoming commits with a log capped at twenty entries. If already up to date,
it restores any automatic stash and exits without verification or pushing.

Otherwise it rebases using the true merge base and `--no-reapply-cherry-picks`,
restores the stash, then verifies detected project types in order:

- .NET: root solution or a project within depth three; build and unit tests.
- Node: root package manifest; prefer Bun, otherwise npm, and run quoted build
  and test names found in the manifest. Any prior verification failure skips
  Node tests, while Node builds and later ecosystems still run.
- Python: root `[project]` metadata; sync with uv and run pytest when test files
  exist within depth three.
- Go: root module; build and test from the repository root.
- dbt: project within depth three; report a skip because warehouse credentials
  are required. Never run warehouse operations as part of catchup.

.NET, Node, and uv retain the caller's working directory. Build tool stdout and
stderr stream together to stdout. A verification failure returns nonzero and
prevents publishing; a repository with no recognized project reports a skip.

## Push behavior

After successful verification, the command uses `git push --force-with-lease`.
It skips pushing when any of these conditions holds:

- The current branch is `main` or `master`.
- The rebase left HEAD unchanged.
- The current branch has no upstream.
- `--no-push` is the final push option.

If the push fails, the local rebase remains available. Inspect `git status` and
`git log @{upstream}..HEAD`; investigate the remote change or lease refusal
before any manual retry. Never substitute plain `--force` or retry blindly.

## On failure

Investigate the evidence before asking targeted questions through the host's
user-question facility. Present concrete options and their consequences; fix
clear build or test causes within the authorized scope and escalate uncertain
decisions with the relevant files and output.

1. **Rebase conflicts:** the command prints conflicting files, aborts the rebase,
   and attempts to restore its stash. Read each file and compare both sides of
   the aborted conflict. Show the competing changes and concrete resolution
   options. Do not automatically resolve rebase conflicts. Honor a resolution
   the user has already selected and authorized.
2. **Stash restoration conflicts:** inspect `git status` and `git stash list`.
   Preserve the stash and conflicted work while identifying the competing
   changes. Verification and pushing have stopped; resolve only an authorized
   concrete choice.
3. **Build failure:** read the errors and `git log --oneline -10`. Compare failing
   files with the pre-rebase state. Check for renamed types, removed APIs, new
   dependencies, and migration collisions.
4. **Test failure:** identify the failing tests, read them and the covered code,
   and determine whether incoming default-branch changes or a regression on this
   branch caused the failure.

A fetch failure can leave the automatic `catchup-auto-stash` intact. Inspect
the stash and working tree before recovery; do not discard user changes.
