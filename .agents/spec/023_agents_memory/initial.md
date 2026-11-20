# .agents as tracked agent memory — Initial Notes

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
