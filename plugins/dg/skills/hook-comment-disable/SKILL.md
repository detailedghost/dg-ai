---
name: hook-comment-disable
description: Disable the American-English PostToolUse hook for the current session. ALWAYS requires explicit user approval before writing the marker — even in auto/yolo mode.
---

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills stash --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.20.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor stash.

# /dg:hook-comment-disable

Turn off the American-English hook (`american-english-hook.sh`) for this session. The hook normally blocks Edit/Write/MultiEdit when newly-written text uses a British spelling.

## Mechanism

Writes a session-scoped marker file:

```
$(~/.dg/bin/dg-skills stash -G hooks comment-disabled.${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-NOSESSION}})
```

The hook checks for this marker on entry and exits 0 immediately if present. Marker lives in `$(~/.dg/bin/dg-skills stash -G hooks)/` (intentionally **not** cwd-scoped — the hook fires on Edit/Write regardless of cwd, so the bypass must too) and is cleaned on reboot. The cleanup walker skips `hooks/` entirely. No manual cleanup required.

## Mandatory user-permission gate

**You MUST obtain explicit user approval via `AskUserQuestion` before writing the marker. This applies in every mode, including auto / yolo / non-interactive. No exceptions.**

The user has chosen to gate this skill behind explicit consent precisely so that bypassing the spelling rule is a deliberate, audited action — not a silent agent decision.

## Procedure

1. The session id is `CLAUDE_CODE_SESSION_ID`, with `CLAUDE_SESSION_ID` as the second choice. If both are unset, the commands below fall back to `NOSESSION` — the hook uses the same fallback, so the bypass still takes effect, but warn the user that the disable is **not session-scoped** and will affect every session that lacks a session id until the marker is removed.
2. Tell the user concretely what is being disabled and why you want to disable it (one sentence).
3. Call `AskUserQuestion` with a single question, two options:
   - **Disable for this session** — writes the marker, hook exits 0 until reboot or marker deletion.
   - **Keep enforcement on** — abort, no changes.
4. Only on explicit "Disable" answer:
   ```sh
   touch "$(~/.dg/bin/dg-skills stash -G hooks comment-disabled.${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-NOSESSION}})"
   ```
5. Confirm to the user that the marker was written, including the path so they can `rm` it manually if they change their mind mid-session.

## Re-enabling

```sh
rm -f "$(~/.dg/bin/dg-skills stash -G hooks comment-disabled.${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-NOSESSION}})"
```

Or wait for reboot (`$(~/.dg/bin/dg-skills stash -r)` cleared).

## When to suggest this skill

- A third-party name, quoted material, or proper noun legitimately carries a British spelling and cannot be changed — a dependency called `colour-convert`, a quoted statute, a person's name.
- The file reproduces text verbatim from an external source.

If the word is ours to choose, change it instead. The hook matches whole tokens, so it already ignores a British string inside a longer word.
