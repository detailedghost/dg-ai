---
name: ls-skills
description: Print a categorized, sorted index of the dg plugin's engineering and personal-workflow skills. Optional arg filters to one category (dev, personal, tools, config).
---

# /dg:ls-skills

Render a tree of dg skills grouped by category. If a category arg was given, show only
that section.

**Usage:** `/dg:ls-skills [dev|personal|tools|config]`

Use the descriptions table below — do not pull from the system prompt.

Scope: the dg plugin skills that trace back to the user's own workflow tooling, now
packaged under `plugins/dg/skills/`. Skills from other plugins or other features that
happen to live in the same plugin tree are not listed, and neither is `ls-skills` itself.
[../README.md](../README.md) is the complete canonical index of every skill the plugin
ships, including the ones out of this scope.

## Descriptions

| skill | description |
|---|---|
| dg:address | Address PR review comments and failing CI |
| dg:agent-seed | Bootstrap .agents/ project structure |
| dg:assign | Pick agents for each spec slice |
| dg:bg | Run a task in the background, agent-agnostic |
| dg:browser | Open PR/URL tabs grouped, play guided in-browser demo tours |
| dg:catchup | Pull latest, rebase, verify build |
| dg:chain | Wire dependent PRs into a merge-order stack |
| dg:claude-sync | DEPRECATED — use `/dg:copilot-sync` or `/dg:opencode-sync` |
| dg:cleanup | `~/.claude/` hygiene — prune orphan dirs and stale files |
| dg:clipboard-img | Extract image from clipboard, save as PNG |
| dg:cls | Close out a worktree — drop branch, sweep scratch assets |
| dg:codex-sync | Sync Claude assets into `$CODEX_HOME` |
| dg:copilot-sync | Sync Claude assets into `~/.copilot` |
| dg:db | Query PostgreSQL and Snowflake |
| dg:demo | Record a walkthrough video plus before/after shots |
| dg:deps-upgrade | Update all dependencies, fix issues, open PR |
| dg:doctor | Check dg skills have what they need, walk through the fixes |
| dg:eli5 | Explain anything like you are five — bullets plus an ASCII picture |
| dg:erd | Architecture/ERD snapshot — code, imports, DB schema |
| dg:file | File, list, and organize a GitHub/GitLab issue |
| dg:find-work | Discover work items, execute each in parallel worktrees |
| dg:grill-me | Design interview — walk every branch until convergence |
| dg:hook-comment-disable | Disable the American-English hook for this session |
| dg:hunt | Structured bug hunt and root-cause diagnosis |
| dg:jot | Temporary agent note, or durable handoff with -s |
| dg:kick | Defer a feature — plan now, build later |
| dg:meaningful | Reshape commits into reviewable chunks |
| dg:monolith | Build codebase vocabulary into .agents/monolith.md |
| dg:nope | Wrong-tool correction + memory write |
| dg:opencode-sync | Sync Claude assets into `~/.config/opencode` |
| dg:overwatch | Keep the shared work board current across chats |
| dg:pickup | Resume a parked spec from .agents/spec/ |
| dg:polish | Quality-cleanup verify step — reuse, simplify, apply fixes |
| dg:prd | Handoff-ready PRD — kick + assign in one shot |
| dg:proto | Prototype locally (terminal app, UI variations, or a clickable walkthrough) or on a live page with `--ext` |
| dg:proxy | Delegate coding tasks to external CLI agents (codex/copilot/pi/opencode) |
| dg:pw | Browser automation: open, click, fill, snapshot, save logins |
| dg:refactor | Find and act on architectural deepening opportunities |
| dg:rename-session | Intelligently rename the current session |
| dg:review-loop | Antagonistic review loop — filter, fix, repeat |
| dg:sdlc | Execution lifecycle for a bare feature brief |
| dg:skill-cleanup | Audit and slim the skill estate — token weight, fixes, restructure |
| dg:skill-publish | Package a CLI or skill as an MCP server |
| dg:sniff | Inventory what an app needs before it can run |
| dg:spec | Plan or execute a durable feature spec bundle — plan-mode interview/roundtable/synthesis, or execute-mode drive `/dg:sdlc` |
| dg:spring-break | Clean up .agents/school/ and burning context |
| dg:standard-test | Language-agnostic test-writing standard |
| dg:stat | Report this session's in-flight work as a table |
| dg:sync | Sync dg assets into another AI tool's home |
| dg:teach | Teach user a skill across multiple sessions |
| dg:test-live | Deploy branch to dev/stage Fargate for live testing |
| dg:ticket | Create a Jira ticket in JRDEV |
| dg:worktree | Manage git worktrees for agent workflows |

## Categories

| category | emoji | members |
|---|---|---|
| dev | 🛠️ | dg:address, dg:assign, dg:bg, dg:catchup, dg:chain, dg:cls, dg:db, dg:demo, dg:deps-upgrade, dg:erd, dg:file, dg:find-work, dg:grill-me, dg:hunt, dg:kick, dg:meaningful, dg:monolith, dg:overwatch, dg:pickup, dg:polish, dg:prd, dg:proto, dg:proxy, dg:pw, dg:refactor, dg:review-loop, dg:sdlc, dg:sniff, dg:spec, dg:standard-test, dg:stat, dg:test-live, dg:ticket, dg:worktree |
| personal | 🧑 | dg:clipboard-img, dg:eli5, dg:jot, dg:nope, dg:teach |
| tools | 🔧 | dg:agent-seed, dg:browser, dg:cleanup, dg:doctor, dg:skill-cleanup, dg:skill-publish, dg:spring-break |
| config | ⚙️ | dg:claude-sync, dg:codex-sync, dg:copilot-sync, dg:hook-comment-disable, dg:opencode-sync, dg:rename-session, dg:sync |

## Render rules

- Preserve member order (already sorted alphabetically)
- Format: `├─ /dg:name   description` with `└─` on the last entry per category
- No leading spaces before connectors
- One blank line between categories
