---
feature: ".agents as tracked agent memory"
feature_snake_case: agents_memory
date: "2026-11-19"
version: "1.0"
status: in-progress
current_slice: 1
pr_strategy: single
slices:
  - id: 1
    name: "track-agents-default"
    depends_on: []
    files: ["plugins/dg/skills/agent-seed/**", "plugins/dg/skills/spring-break/**", "plugins/dg/skills/spec/SKILL.md", "plugins/dg/skills/spec/references/fast.md", "plugins/dg/skills/spec/references/plan.md", "plugins/dg/skills/kick/SKILL.md", "plugins/dg/skills/pickup/SKILL.md", "plugins/dg/skills/prd/SKILL.md", "plugins/dg/skills/wayfinder/SKILL.md", "plugins/dg/skills/proto/references/local-*.md", "pkg/skills-test/__tests__/spec-bundle-commit.spec.ts", "pkg/skills-test/__tests__/agents-tracked.spec.ts"]
    agents:
      primary: dg:lore
      confidence: high
      complexity: medium
      qa: [dg:reviewer]
  - id: 2
    name: "agents-read-agents-folder"
    depends_on: [1]
    files: ["plugins/dg/agents/*.md", "plugins/dg/skills/agent-seed/references/templates.md", "plugins/dg/skills/sdlc/references/templates/lore.md", "plugins/dg/skills/adr/references/write-decision.md", "plugins/dg/skills/spring-break/references/structure.md", "pkg/skills-test/__tests__/agents-memory.spec.ts"]
    agents:
      primary: dg:lore
      confidence: high
      complexity: medium
      qa: [dg:reviewer]
  - id: 3
    name: "adr-lint-decision-size"
    depends_on: []
    files: ["pkg/skills-cli/src/adr/lint.ts", "pkg/skills-cli/__tests__/adr-lint*.spec.ts", "plugins/dg/skills/adr/SKILL.md"]
    agents:
      primary: dg:js
      confidence: high
      complexity: low
      qa: [dg:qa-code]
execution:
  profile: balance
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
---

# .agents as tracked agent memory

## Purpose
Make .agents/ tracked, token-light agent memory in every repo the skills seed. Agents lazy-load .agents (decisions, school, references, monolith, paths), never docs/adr, which is for people. Drop the git add -f workarounds, add a learning-capture step to the lore template, write token caps for decisions and references, and lint oversized decisions.

## Scope
### Included
- agent-seed and spring-break track .agents/ and ignore only the scratch list
- remove every git add -f .agents workaround and its agent-seed note
- shared persona memory line and AGENTS.md Rules line
- lore template school promotion step
- token caps for decisions (25 lines) and references (150 lines)
- adr lint rule decision-too-long
### Excluded
- dg-ai root .gitignore and .agents/school, monolith, references (separate PR)
- school, paths.md, monolith and AGENTS.md caps stay as they are
- /dg:adr ask mode keeps reading docs/adr

### Slice 1 — track-agents-default

#### Engineering
- [x] agent-seed tracks .agents/; its .gitignore entry is the scratch list only: .agents/verify/, .agents/code-review/, .agents/jot/, .agents/clipboard/, .agents/spec/*/roundtable/
- [x] The check-in question stays for repos with private notes; track is the recommended answer
- [x] Migration: replace an existing .agents/ or .agents/* ignore block with the scratch list, never stack a second block
- [x] spring-break checks and fixes the same thing
- [x] Remove every git add -f and every agent-seed-ignores-.agents note; bundle commits are a plain git add with a fallback ':(exclude)<bundle>/roundtable/' pathspec
- [x] .agents/ is tracked agent memory; scratch subfolders are ignored
- [x] proto narrows its ignore to the prototype scratch files, so NOTES.md answers stay tracked

#### Testing Criteria
##### Contracts
- [x] Contract: the agent-seed template lists exactly the scratch set
- [x] Contract: no skill file contains git add -f .agents
- [x] Contract: no skill file calls .agents/ gitignored by default
- [x] Contract: every spec bundle add carries the roundtable exclude pathspec and none uses add -f

#### Acceptance Criteria
- [x] rg 'git add -f \.agents' over plugins/dg/skills returns nothing
- [x] bun test in pkg/skills-test passes

### Slice 2 — agents-read-agents-folder

#### Engineering
- [ ] Every persona Project-scope carries the shared memory line: read .agents/school/<topic>.md; when .agents/decisions/README.md exists run dg-skills adr relevant <files> --json and read only the listed decisions; never read docs/adr
- [ ] AGENTS.md template Rules line: Agents read .agents/ (decisions, school, references, monolith, paths); docs/adr is human-only
- [ ] Lore template promotes each durable rule, trap or standard into .agents/school/<topic>.md as one dated, deduplicated line; decisions go through the decision pair; prune oldest at the cap
- [ ] Cap table in structure.md and write-decision.md: decisions 25 lines, references 150 lines then split by topic

#### Testing Criteria
##### Contracts
- [ ] Contract: every persona file contains the shared memory line
- [ ] Contract: no persona or build skill tells an agent to read docs/adr; /dg:adr ask mode is exempt
- [ ] Contract: the lore template has the school promotion step
- [ ] Contract: the cap table is present

#### Acceptance Criteria
- [ ] bun test in pkg/skills-test passes

### Slice 3 — adr-lint-decision-size

#### Engineering
- [ ] New lint rule decision-too-long: more than 25 non-blank lines below the frontmatter
- [ ] Same finding shape and exit codes as the other rules
- [ ] adr SKILL.md names the rule

#### Testing Criteria
##### Contracts
- [ ] Contract: a decision with 25 non-blank body lines is clean
- [ ] Contract: a decision with 26 non-blank body lines yields decision-too-long and exit 1

#### Acceptance Criteria
- [ ] adr lint --all on dg-ai master stays clean, or the PR lists every hit
- [ ] bun test in pkg/skills-cli passes

## Slice Summaries
- Slice 1 (track-agents-default): agent-seed writes only the scratch list to .gitignore and replaces an old .agents/ or .agents/* block; spring-break step 9 does the same fix. Every git add -f of .agents is gone (spec, fast, plan, kick, pickup, prd, wayfinder, agent-seed backups); bundle adds keep the roundtable exclude fallback, and spec says to ask for /dg:spring-break when git add refuses, never -f. proto tracks only NOTES.md per prototype. Tests: agents-tracked.spec.ts, spec-bundle-commit.spec.ts.

## Agent Notes
- (slice 1) Scratch list uses .agents/spec/**/roundtable/ instead of the plan's spec/*/roundtable/, so prd's spec/todo/<slug>/roundtable/ is covered too.
- (slice 1) proto ignore narrowed to .agents/prototype/*/* with !.agents/prototype/*/NOTES.md. The agent-seed temp-repo fixture is not automatable (agent-seed is prose, no CLI), so tests pin the template text.

## Issues Remediation
