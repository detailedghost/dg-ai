<!-- markdownlint-disable MD013 MD041 MD060 -->

# /dg:land Workflow

Each step lists `IN:` and `OUT:`. A gate is a hard stop: print
`land: <state>: <diagnostic>`, then the suggested next step, and exit.

## Step 0 — Parse the arguments

- One positional argument is the PR number or URL. With none, use the PR of the current branch.
- `rounds = 3`, `ciRetries = 2`, `backend = codex`, `waitTimeout = 1800`, `earlyStop = true`, `merge = true`.
- `-p copilot` → stop with `land: copilot-refused: this repo never uses Copilot; pick codex, pi, opencode or grok.`
- Check any other backend against `dg-skills proxy --list-backends`. An unknown name stops and lists the valid ones.
- Two merge-method flags → stop and name both.

## Step 1 — Resolve the PR

IN: the arguments. OUT: `pr`, `base`, `headRef`, `sha`, `checkout`, `diffBase`, `method`.

1. `dg-skills vcs-provider capabilities`. When `kind` is not `github`, stop with `land: not-github`.
2. `gh pr view <pr> --json number,url,state,isDraft,isCrossRepository,headRefName,baseRefName,headRefOid`.
   - `state` is not `OPEN` → stop with `land: not-open`.
   - `isDraft` is true → stop with `land: draft: mark #<n> ready first (gh pr ready <n>).`
   - `isCrossRepository` is true → stop with `land: fork: #<n> comes from a fork; land pushes fixes to its branch, so land it by hand.`
3. **Stacked check.** `dg-skills vcs-provider list-prs --head <baseRefName>`. Keep rows with `state` `OPEN`. Any row means the base branch is the head of an open PR → stop with `land: stacked: #<n> sits on #<parent>. Merge #<parent> first, or use /dg:chain.`
4. **Checkout.** When `git branch --show-current` is `headRefName`, `checkout` is the current directory. Otherwise find the worktree on that branch in `git worktree list --porcelain`. With none, stop with `land: no-checkout: check out <headRefName> or run from its worktree.` Prefix every later git, review and address command with `cd "<checkout>" &&`.
5. `git -C <checkout> fetch origin <baseRefName> <headRefName>`. Compare local `HEAD` with `headRefOid`:
   - equal → continue.
   - local is ahead → `git push`, then continue.
   - local is behind or the two differ → stop with `land: head-mismatch: pull or push <headRefName> first.`
6. `diffBase` is `-b <ref>` when given. Otherwise `git merge-base HEAD origin/<baseRefName>`.
7. `method`: read `gh api repos/{owner}/{repo} --jq '{squash:.allow_squash_merge,merge:.allow_merge_commit,rebase:.allow_rebase_merge}'`. A method flag the repo does not allow → stop with `land: method-not-allowed` and name the allowed ones. With no flag: `squash` when allowed, else the first allowed of `merge`, `rebase`.

GATE: GitHub, open, not draft, not stacked, a checkout on the PR head, local and remote heads equal.

## Step 2 — Review rounds

IN: `checkout`, `diffBase`, `backend`, `rounds`, `earlyStop`. OUT: `roundsRun`, `findingsFixed`, new `sha`.

`/dg:review-loop` counts its rounds from the `(review-loop round N)` commit markers in `git log <diffBase>..HEAD`. Earlier rounds on the branch count against its cap. Read the count first:

```sh
before=$(git log <diffBase>..HEAD --format=%s | grep -c '(review-loop round ' || true)
```

- **Default.** Load [../../review-loop/SKILL.md](../../review-loop/SKILL.md) and run it as `/dg:review-loop -p <backend> -b <diffBase> -r <before + rounds>`. It stops by itself at the first dry round. `/dg:address -l --round N` triages, fixes, commits and pushes each round.
- **`--no-early-stop`.** Run `/dg:review-loop -p <backend> -b <diffBase> -r <before + rounds> -s` once per round, `rounds` times. Count the runs here, because a dry round writes no marker.
- After the loop, `after` is the same marker count. `roundsRun` is the number of review runs. `findingsFixed` is `after - before` rounds with fixes; list their commit subjects.
- When local `HEAD` is ahead of `origin/<headRefName>`, run `git push`. Set `sha` to the new `git rev-parse HEAD`.

GATE: review-loop exited 0. On a non-zero exit, stop with `land: review-failed` and show its error.

## Step 3 — CI

IN: `pr`, `sha`, `ciRetries`, `waitTimeout`. OUT: `ci` (`pass`, `none`), `attempts`, final `sha`.

1. Read `gh pr view <pr> --json headRefOid -q .headRefOid` up to 6 times, 10 seconds apart, until it equals `sha`. GitHub can take a few seconds after a push. Still different → stop with `land: head-moved: the PR head is not <sha>. Pull, then re-run.`
2. Watch the checks. Run this as a background job and wait on its exit (see the `/dg:bg` wait rule). The foreground cap is shorter than `waitTimeout`.

   ```sh
   timeout <waitTimeout> gh pr checks <pr> --watch --fail-fast --interval 30
   ```

   | Exit | Meaning | Next |
   |---|---|---|
   | `0` | All checks pass. | `ci = pass`, step 4. |
   | `124` | The wait timed out. | Stop with `land: ci-timeout`. Re-run `/dg:land` later. |
   | `1`, output says no checks are reported | CI did not start yet, or the repo has no CI. | Wait 60 seconds, watch once more. Still none → `ci = none`, step 4. |
   | `1`, `8`, other | A check failed. | Step 3.3. |

3. **Fix.** When `attempts < ciRetries`:
   - `dg-skills address gather-ci-failures <pr>` lists the failed jobs.
   - Load [../../address/SKILL.md](../../address/SKILL.md) and run `/dg:address -m "Fix the failing CI checks. Do not request a Copilot review."`. It fixes, commits and pushes.
   - `attempts += 1`, set `sha` to the new head, go back to step 3.1.
4. When `attempts == ciRetries` and CI still fails, stop with `land: ci-failed` and list each failed job: name, conclusion, URL.

GATE: `ci` is `pass` or `none`.

## Step 4 — Merge state

IN: `pr`. OUT: `mergeState`.

`gh pr view <pr> --json mergeable,mergeStateStatus,headRefOid`. `UNKNOWN` means GitHub still computes it: query again after 10 seconds, up to 3 times.

| `mergeStateStatus` | Next |
|---|---|
| `CLEAN`, `HAS_HOOKS` | Step 5. |
| `BEHIND`, `DIRTY` (or `mergeable` is `CONFLICTING`) | Stop with `land: needs-catchup: run /dg:catchup, then /dg:land again.` Do not rebase or resolve here. |
| `BLOCKED` | Stop with `land: blocked` and name what blocks it: a required review, a required check, or a rule. |
| `UNSTABLE` | Stop with `land: unstable` and list the checks that are not green. |
| `DRAFT` | Stop with `land: draft`. |

GATE: `CLEAN` or `HAS_HOOKS`, and `headRefOid` still equals `sha`. A new head means someone pushed: stop with `land: head-moved` and re-run.

## Step 5 — Merge gate

IN: everything above. OUT: `mergeCommit`, or a stop.

1. **Stacked children.** `gh pr list --base <headRefName> --state open --json number,title`. These PRs use the branch that the merge deletes as their base.
2. **Summary.** Print: PR number and title, `roundsRun`, the fixes from step 2, CI result and attempts, `sha`, `method`, and each child PR.
3. **`--no-merge`** → print `land: ready to merge #<n> at <sha>.` and the command from 5.5, then go to step 7.
4. **Not the main loop** → a subagent, a slice wave or a `--bg` run never merges. Print the summary and the command from 5.5 and stop. The caller relays it to the human.
5. **Ask.** In the main loop, ask with `AskUserQuestion`: `Merge #<n> at <short sha>?`. Options: `Merge (<method>, delete branch)` and `Stop here`. When children exist, the question names them and says GitHub moves them to `<baseRefName>`.
6. **Merge.** On yes, run:

   ```sh
   gh pr merge <n> --repo <owner>/<repo> --<method> --delete-branch --match-head-commit <sha>
   ```

   `<owner>/<repo>` comes from `gh repo view --json nameWithOwner -q .nameWithOwner`. With `--repo`, `gh` deletes only the remote branch. The local branch and its worktree stay for `/dg:cls` or `/dg:address`, which a `/dg:spec` run needs.

   - The harness, auto mode or a hook blocks it → print `! gh pr merge <n> --repo <owner>/<repo> --<method> --delete-branch --match-head-commit <sha>` for the human to run in the prompt, and stop. Never retry it another way.
   - `gh` refuses because the head moved → stop with `land: head-moved`.
   - Success → read `gh pr view <n> --json state,mergeCommit`. `state` `MERGED` → `mergeCommit` is `.mergeCommit.oid`. `state` `OPEN` means a merge queue took it, or auto-merge waits: stop with `land: queued: #<n> waits in the merge queue.` and skip step 6.

GATE: `state` is `MERGED`, or the run stopped with the reason or the command printed.

## Step 6 — Children of the deleted branch

IN: the child list from step 5.1. OUT: `children` with their state.

When GitHub deletes the head branch of a merged PR, it moves each open PR that used that branch as its base to the merged PR's base. Check that it did: `gh pr view <child> --json state,baseRefName` for each child.

- Open, base is `<baseRefName>` → report it as moved.
- Open, base still `<headRefName>` → run `gh pr edit <child> --base <baseRefName>` and report it.
- Closed → report it with `gh pr reopen <child>` and `gh pr edit <child> --base <baseRefName>` for the human. Do not reopen it here.

## Step 7 — Final report

Print one block:

```text
land: #<n> <merged|ready|stopped at <state>>
  head      <sha>
  merge     <mergeCommit or none>
  review    <roundsRun> round(s), <findingsFixed> with fixes, backend <backend>
  CI        <pass|none|failed> after <attempts> fix attempt(s)
  children  <#x moved to <base> | none>
  left      <failed jobs, blocked reason, deferred findings, or nothing>
```

After a merge, suggest `/dg:cls` to remove the local worktree and branch.
