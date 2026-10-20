# Ref + repo resolution

- **repo:** `git rev-parse --show-toplevel`.
- **explicit range** (`A..B` or `A B` in args): use verbatim.
- **default range** (no args):
  - `head = HEAD`.
  - `base =` the branch's fork point: `git merge-base HEAD "$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || git rev-parse --abbrev-ref origin/HEAD | sed 's#^origin/##')"`. If that fails, fall back to `origin/HEAD`.
  - **In a `/spec` worktree** (spec frontmatter has a `worktree:` block, or you're on a `feature/*` branch cut from an integration branch): prefer `base =` that integration/base branch, `head =` the feature branch tip — reviews exactly what the feature added.
- The board reviews **committed** refs. Commit work first (per-slice commits are ideal); uncommitted changes won't appear. If the caller wants to review WIP, tell them to commit, or diff `HEAD` against a stash-backed ref.
- **`--spec`:** if not passed, auto-detect an in-progress spec: the single `.agents/spec/*/plan.md` with `status: in-progress` (skip if 0 or >1). Passing it tags each file with its spec slice in the board's "By spec slice" grouping.

## Acting on the result

Local-range mode only — `-x`/`--external` posts straight to GitHub instead (`references/external.md`).

- **`approve`** → report the approval + summary; proceed. The board shows "Approved — thanks!" and attempts to close its own tab (a short delay so that message is visible first); browsers can refuse a script-driven close once the click's user activation has lapsed, so treat the close as best-effort — the overlay's own "you may close this tab" hint is the fallback the reviewer sees either way.
- **`request_changes`** → on submit the board switches itself to a **"reworking" loading state** (spinner + "applying your feedback"), so the reviewer sees the loop is live. Treat every `lineComments[]` entry + the `summary` as work items: fix each at its `file:lineNumber`, commit, then **re-render the SAME board** — re-run `~/.dg/bin/dg-skills viz review` on the updated range. The slug is deterministic (repo+head+session), so it reuses the same slug/URL and bumps the payload `rev`; the open board's poll detects the bump and reloads itself into the revised review (loading state gone, verdict buttons live). Then **re-arm the gate (step 1b in SKILL.md's Flow)** and wait again — without that the verdict you just acted on can satisfy the next wait immediately. Repeat until `approve`.
- **`comment`** → surface the comments; ask the caller whether to address or proceed.
- Always echo the verdict + a concise digest of the comments back to the caller — don't silently swallow them.

`--no-wait`: run step 1 only (render + print the URL) and return the slug, for when the caller wants to open the board now and collect the review later with `~/.dg/bin/dg-skills viz wait`.
