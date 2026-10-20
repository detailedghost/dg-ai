---
name: polish
description: Quality-cleanup verify step — reviews changed code for reuse, simplification, efficiency, altitude, self-inflicted dead code, outdated API usage, comment bloat, and hygiene (lint/imports/style) cleanups, then applies the fixes. Fanned out to the matching language subagent per file group, with a dedicated judgment pass deciding what's actually worth fixing. Quality only, no bug hunting.
---

# Skill: polish

Quality-only cleanup pass over the current diff, meant to run as a verify step (e.g. after implementation work, before a final review). Finds and fixes, doesn't just report. Unlike a single generalist pass, this skill delegates: each file group goes to the subagent that actually owns that language, and a dedicated judgment call decides what's worth touching before anything gets applied.

## CLI

The PR flow calls the `dg-skills chain` helper. First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills chain --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.16.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

## Scope

- No args: `git diff --name-only $(git merge-base HEAD origin/<default-branch>)` (fall back to working-tree diff if the branch has no upstream base, or to `git status --short` paths if there's no diff at all — e.g. mid-edit on uncommitted work).
- With args: treat each as a path/glob and scope the review to those files instead of the full diff.
- Skip files that are pure test/doc/config unless the diff shows a test re-implementing production logic (see `standard-test` skill) or a comment that's now stale. "Config" here means *declarative* config only (JSON/YAML/TOML/`.env`) — **code-bearing source files are always in scope even when they're named `*Config`/`*Settings`/`*.Models`**: a `SomethingConfig.FromEnv()` or settings/model source file that declares parsing/helper logic is production code, and its little private helpers are a prime utility-placement target (dimension 1), not something to skip.

## Dimensions (quality only)

1. Reuse
2. Simplification
3. Efficiency
4. Altitude
5. Dead code we introduced
6. Latest-feature appropriateness
7. Hygiene
8. Preferred constructs
9. Comment bloat

Names only — the full per-dimension criteria, examples, and out-of-scope redirect table live in [references/dimensions.md](references/dimensions.md). Read that file at step 3 below; its text is what goes into each Find-phase brief, not this list.

## Process

1. **Compute scope** (see above).
2. **Group by owning agent.** Bucket the changed files using the same language→agent heuristics `/assign` already uses ([../assign/SKILL.md](../assign/SKILL.md), "Picking heuristics" — reuse that table, don't re-derive it: C#→`csharp`, Python→`python`, TS/JS→`js`, shell→`shell`, Terraform/Docker/CI→`devops`, Snowflake/migrations→`dba`, docs→`lore`). No strong signal → `reviewer`.
3. **Find (parallel, one Agent call per group).** Launch the owning agent for each group — session-inherited model, no special pin, this is bulk detection not judgment. Read [references/dimensions.md](references/dimensions.md) and brief each with: its file list, the full per-dimension text from that file (not just the names in Dimensions above), and explicit instructions to find candidates ONLY, not edit yet, and not to hunt correctness/security/test-coverage issues (that's out of scope — have it flag those separately instead of silently dropping them; the same file has the exact redirect routing). Each returns a findings list: `{file, dimension, issue, suggestedFix}`.
4. **Judge (single Agent call).** This is the taste call, not detection — hand it every group's raw findings together. It must: dedupe overlapping findings, drop anything that's speculative/low-value churn relative to the diff (YAGNI applies to the cleanup itself, not just the code), reclassify anything that's actually a correctness/security/test-coverage concern into a `redirects` list instead of a fix, and emit a final `{group, approvedFixes[]}` plan plus the `redirects[]`.
5. **Apply (parallel, one Agent call per group with an approved fix).** Re-launch each group's owning agent, Edit access, briefed with ONLY that group's `approvedFixes` from step 4 — apply exactly those, nothing else, keep each fix minimal and scoped.
6. **Report.** Assemble the summary directly from step 5's returns (no extra agent call needed): one line per fix (file, dimension, what changed). Append the `redirects[]` from step 4 as pointers, not auto-run actions ([references/dimensions.md](references/dimensions.md) has the exact routing). If nothing was found, say so plainly rather than inventing busywork.

## References (load on demand)

| When you need to… | Read |
|---|---|
| Full per-dimension criteria/examples, and the out-of-scope redirect table (correctness/security/test-coverage/reformatting/design-decision handoffs) | [references/dimensions.md](references/dimensions.md) |
| Know what runs after polish finishes (code-review pass, then opening a PR) | [references/after-polish.md](references/after-polish.md) |
| Write the PR description (4-sentence limit, table/bullet/demo-video shape, `unslop` de-slop pass, prose check, stacked-PR arrow chain, cross-repo links) | [references/pr.md](references/pr.md) |
| Check a PR body for plain English, active voice, and short sentences before `gh` or `glab` blocks it | [references/pr-body-style.md](references/pr-body-style.md) |
