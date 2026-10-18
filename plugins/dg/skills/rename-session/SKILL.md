---
name: rename-session
description: Intelligently rename the current session — generates 3 candidate names from conversation context + git state, with PR # prefix if a branch PR exists. Picks up fast on what the session has been about.
---

# Skill: rename-session

Rename the current Claude Code session. Without an argument, reads conversation context and git signals to propose 3 candidates; you pick one. With an argument, writes the name immediately.

**Usage:**
- `/rename-session` — generate candidates, auto-apply the best one
- `/rename-session --pick` — same but prompt to choose from 3 options
- `/rename-session my custom name` — write directly, no generation

## Steps

### Direct rename (argument provided, no `--pick`)

If invoked with a name argument (anything that isn't `--pick`), skip to **Write** immediately.

### Auto-propose flow

**1. Gather git signals** (run all in parallel, ignore failures)

```bash
git branch --show-current 2>/dev/null
git log --oneline -5 2>/dev/null
git status --short 2>/dev/null
gh pr view --json number,title 2>/dev/null
```

**2. Synthesize 3 candidates**

Using the conversation context (what has been discussed and done this session) plus the git signals above, generate exactly 3 candidate names following these rules:

- Space-separated words, 3–6 words each (e.g. `fix flyway migration`, not `fix-flyway-migration`)
- If a PR was found: prefix **all 3** with `#NNN ` (e.g. `#853 fix flyway duplicate`)
- If no PR: topic-based names only
- Vary the framing — e.g. task-centric, area-centric, outcome-centric — so options are meaningfully different, not just synonyms
- The **first** candidate is the strongest/most descriptive — it's the default

**3a. Default (no `--pick`):** skip AskUserQuestion, use the first candidate directly → go to Write.

**3b. With `--pick`:** present via AskUserQuestion, one question, 3 options. The system adds "Other" automatically.

**4. Write the rename**

```bash
session_file=$(grep -rl "$CLAUDE_CODE_SESSION_ID" ~/.claude/sessions/ 2>/dev/null)
tmp=$(mktemp)
jq --arg name "CHOSEN_NAME" '. + {name: $name}' "$session_file" > "$tmp" && mv "$tmp" "$session_file"
```

Confirm: print `Session renamed to: <name>`

If `$CLAUDE_CODE_SESSION_ID` is unset or no session file is found, print an error and stop.
