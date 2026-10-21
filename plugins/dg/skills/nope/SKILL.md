---
name: nope
description: Stop. Wrong tool. Reminder of correct file-search defaults (LSP → fff MCP → ripgrep → builtin) AND records a feedback memory entry so the agent stops reaching for the wrong tool unprompted. Use when an agent reaches for find/grep/cat or built-in Grep/Glob before trying preferred tools.
---

# Skill: Nope

You picked the wrong tool. Reset and use the correct defaults.

**Usage:** `/dg:nope`

## Tool order (top to bottom — fall through only on failure)

1. **LSP** — for symbol lookups (definitions, references, type info, call sites). Use when you have an identifier name and want semantic results, not text matches.
2. **fff MCP** — for content search and file finding:
   - `mcp__fff__grep` — DEFAULT for content search by bare identifier
   - `mcp__fff__multi_grep` — OR logic across multiple identifiers (case variants, snake/Pascal)
   - `mcp__fff__find_files` — when you don't have a specific identifier and need to discover files by topic
3. **ripgrep via Bash** — `Bash(rg 'pattern' path/)` or `Bash(rg --files path/ | rg 'pattern')`. Use only when fff is unavailable or returns nothing useful.
4. **Built-in `Grep` / `Glob`** — last resort.

## Never

- `find`, `grep`, `ls`, `cat`, `head`, `tail` via Bash when any tool above fits
- Do not write your own JSON reader; use `jq`.
- Regex with `.*`/`\d+`/`\s+` in fff grep — search bare identifiers
- More than 2 grep variations before reading a file

## What to do now

### 1. Re-run the search correctly

Identify the highest-tier tool that fits the search you just attempted, run it, then continue the original task.

### 2. Record a learning (so this decays over time)

Use your own active memory directory, the one your runtime already loads for this project:
- **Main agent**: the project auto-memory index file (`MEMORY.md`) in that directory.
- **Subagent**: your agent-specific memory directory.

Add or update **one** feedback entry under a `## Tool Defaults` section (create the section if missing). Format:

```markdown
## Tool Defaults

- [YYYY-MM-DD ×N] Reached for `<wrong-tool>` to <what you were searching>. Correct order: LSP → fff MCP → rg → builtin. /dg:nope invoked.
```

Rules:
- If a similar entry already exists (same wrong-tool reach), **update its date and increment ×N** — do NOT add a duplicate line.
- Keep the section bounded to the 5 most recent entries; prune older ones.
- This is the decay mechanism: each `/dg:nope` strengthens the prior, so future turns stop reaching for the wrong tool unprompted.

### 3. Acknowledge briefly

One line back to the user: which wrong tool you used, which correct tool you're switching to, and that you logged the learning. No long apology.
