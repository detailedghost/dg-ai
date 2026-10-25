---
name: find-work
description: Discover actionable work items, present for selection, execute each in a parallel worktree — implement, test, commit, push — then human-review and open PRs in batch.
---

# /dg:find-work — Discover & Execute Work Items

Scan multiple sources for small/medium actionable work, let the user pick what to tackle, then execute each in an isolated git worktree. Lightweight — no interview, no spec, no roundtable.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills vcs-provider --help >/dev/null 2>&1 &&
  ~/.dg/bin/dg-skills worktree --help >/dev/null 2>&1 &&
  ~/.dg/bin/dg-skills chain --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.20.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor chain stash vcs-provider worktree.

## Usage

**Usage:** `/dg:find-work`

## Reference Files (lazy-load)

| File | When to read |
|------|-------------|
| [references/phases.md](references/phases.md) | At start — phase details, gates, ranking, error handling |
| [references/discovery-prompts.md](references/discovery-prompts.md) | Phase 1 — discovery agent prompts |
| [references/execution-template.md](references/execution-template.md) | Phase 3 — worktree agent prompt template |

## Phase Overview

| # | Phase | Gate |
|---|-------|------|
| 0 | **Preflight** — git repo, VCS provider auth, fetch, detect default branch | All checks pass |
| 1 | **Discover** — 4 parallel agents scan sources, merge/dedup/rank top 5 | >= 1 item found |
| 2 | **Select** — AskUserQuestion multiSelect (top 4 + Other), Jira follow-up | >= 1 item selected |
| 3 | **Execute** — parallel worktree agents: implement, test, commit, push, return PR body draft | All agents returned |
| 3.5 | **Human Review** — consolidated table, AskUserQuestion: open all / choose / hold | User approves ≥1 or holds |
| 4 | **Report** — summary table: status, branch, PR URL (or held) per item | Summary delivered |

## Context Conservation

- **Lazy-load only.** Read each reference file at its phase, not before.
- **`/compact` after Phase 1** (drop discovery-prompts.md) and **after Phase 2** (before loading execution-template.md).
- **Discovery agents use `model: "haiku"`** — they run commands and filter, not reason deeply.
- **Execution agents use `model: "sonnet"`** — they write code.
- **Agents return JSON only** — no prose, no explanation. The orchestrator extracts what it needs.
- **Do NOT echo agent results** back to the user verbatim. Summarize into the compact tables shown in phases.md.

## Rules

- **Speed over ceremony.** No interview, no spec, no roundtable. Discover, pick, build, ship.
- **Max 5 discovered items.** Rank by effort (prefer small), recency, and impact.
- **Max 4 selectable.** AskUserQuestion constraint. 5th available via Other.
- **Each worktree agent is self-contained through push.** Implement, test, commit, push, return `pr_body_draft`. PRs are opened by the orchestrator only after Phase 3.5 human approval. Branch creation: the orchestrator pre-creates each worktree and branch through the worktree command and the agent uses it as-is (see `references/phases.md` Phase 3).
- Use TaskCreate/TaskUpdate to track each selected item through execution.
- Conventional commits: `<type>(<scope>): <description>`.
- NEVER skip a gate condition.
