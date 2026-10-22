# Discovery Agent Prompts

All 4 agents launch in **parallel** during Phase 1. Each returns a JSON array.

## Common Output Schema

```json
[
  {
    "id": "unique-id (issue #, file:line, PR #)",
    "title": "Short actionable title (imperative mood)",
    "source": "vcs-issue|code-quality|pr-backlog|codebase-scan",
    "file": "path/to/file (if applicable, else null)",
    "line": 42,
    "effort": "patch|minor|moderate",
    "kind": "test-failure|bug|pr-review|tech-debt|style",
    "ageDays": 12,
    "description": "1-2 sentence context for the implementer"
  }
]
```

`kind` feeds the impact score. `ageDays` is days since the item surfaced, or -1 if unknown.

Return **max 3 items** per agent. Prefer items completable in a single focused session. If nothing qualifies, return `[]`.

**IMPORTANT: Return ONLY the raw JSON array. No prose, no explanation, no markdown fencing. Just `[{...}, ...]` or `[]`.**

______________________________________________________________________

## Agent 1: VCS Issues

**Prompt:**

> Discover small/medium GitHub or GitLab issues suitable for a quick implementation PR/MR.
>
> Run: `~/.dg/bin/dg-skills vcs-provider list-issues --limit 20`
>
> **Include** issues that:
>
> - Have labels containing "bug", "good first issue", "small", "quick", "p1", "p2", or no labels at all (often small tasks)
> - Have short bodies (< 500 chars) suggesting limited scope
> - Can likely be fixed in < 200 lines of code changes
>
> **Exclude** issues:
>
> - Labeled "epic", "large", "discussion", "question", "wontfix", "enhancement" (if body suggests large scope)
> - With > 10 comments (likely contentious or complex)
> - That are feature requests requiring design decisions
>
> For each candidate, read the issue body and quickly assess scope. If it references specific files or error messages, note them.
>
> Return up to 3 items as a raw JSON array matching the common schema. No prose — JSON only.
> If no issues qualify, return `[]`.

______________________________________________________________________

## Agent 2: Code Quality

**Prompt:**

> Scan the codebase for actionable code quality items. Check in this order:
>
> 1. **TODO/FIXME/HACK/XXX comments**: Run `rg -n "TODO|FIXME|HACK|XXX" --glob "*.{ts,tsx,js,jsx,py,cs,go,rs,java,rb,php}"` and collect results with surrounding context.
> 1. **Skipped tests**: Run `rg -n "skip|pending|xit\(|xdescribe\(|xtest\(|@pytest.mark.skip|@Ignore|\.Skip" --glob "*.test.*" --glob "*.spec.*" --glob "*_test.*"`
> 1. **Lint config**: Check for eslint, ruff, pylint, golangci-lint configs. If found, note but do NOT run the linter (too slow for discovery).
> 1. **Oversized functions/files**: Run `wc -l` on source files. Flag files > 500 lines or look for functions > 100 lines in recently-changed files.
>
> **Prioritization:**
>
> - TODO/FIXME with dates or ticket references → highest (someone meant to fix this)
> - Items in recently-changed files (`git log --since=2.weeks --name-only`) → higher
> - Skipped tests → medium (quick wins)
> - Oversized functions → lower (subjective)
>
> **Skip vague items**: "TODO: refactor this" is too vague. "TODO: handle null case for user.email" is specific and actionable.
>
> Return up to 3 items as a raw JSON array. No prose — JSON only. Each must be specific enough to implement without further discussion.
> If nothing actionable, return `[]`.

______________________________________________________________________

## Agent 3: PR Review Backlog

**Prompt:**

> Find open PRs with unaddressed review comments that need concrete code changes.
>
> Run: `~/.dg/bin/dg-skills vcs-provider list-prs --limit 15`
>
> Check review threads with `~/.dg/bin/dg-skills vcs-provider list-threads <number>`.
>
> **Include** PRs where:
>
> - The source branch belongs to work this repository can update
> - Review comments describe concrete, implementable changes (not open questions or nits)
> - The requested change is small (single file or localized)
>
> **Exclude:**
>
> - PRs with only "LGTM" or approval comments
> - Comments that are questions, discussions, or architectural debates
> - PRs touching > 20 files (too complex for quick fixes)
>
> Return up to 3 items as a raw JSON array. No prose — JSON only. Title format: "Address review: <summary> in PR #N".
> Set `file` to the file mentioned in the review comment. Set `id` to the PR number.
> If no qualifying PRs, return `[]`.

______________________________________________________________________

## Agent 4: Codebase Scan (QA + Reviewer)

**Prompt:**

> You are a combined reviewer scanner. Do a fast sweep of recently-changed files to find implementable improvements.
>
> 1. Get recently touched files: `git log --format= --since=1.week -n 20 --name-only | grep -v '^$' | sort -u`
>
> 1. For each file (read up to 10 files max), do a quick review pass looking for:
>
>    - **Null/undefined risks**: Accessing `.property` without null checks, missing optional chaining
>    - **Missing error handling**: Bare try/catch, unhandled promise rejections, missing error returns
>    - **Dead code**: Exported functions/variables with zero imports (quick `rg` check)
>    - **Obvious bugs**: Wrong comparison operators, off-by-one, swapped arguments, unreachable code
>    - **Test gaps**: Source files with no corresponding test file
>
> 1. Only report items you are **confident** about — no speculative or stylistic findings.
>
> **Prioritize**: bugs > missing error handling > null risks > test gaps > dead code.
> **Skip**: formatting, naming conventions, import ordering — these are linter territory.
>
> Return up to 3 items as a raw JSON array. No prose — JSON only. Each must include specific `file` and `line`.
> If nothing concrete found, return `[]`.
