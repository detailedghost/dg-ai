---
name: hook-comment-disable
description: Disable the American-English PostToolUse hook for the current session. ALWAYS requires explicit user approval before writing the marker — even in auto/yolo mode.
---

Resolve the CLI before using the commands below:

```bash
DG="${DG_HOME:-$HOME/.dg}/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

# /hook-comment-disable

Turn off the American-English hook (`american-english-hook.sh`) for this session. The hook normally blocks Edit/Write/MultiEdit when newly-written text uses a British spelling.

## Mechanism

Writes a session-scoped marker file:

```
$("$DG" stash -G hooks comment-disabled.$CLAUDE_SESSION_ID)
```

The hook checks for this marker on entry and exits 0 immediately if present. Marker lives in `$("$DG" stash -G hooks)/` (intentionally **not** cwd-scoped — the hook fires on Edit/Write regardless of cwd, so the bypass must too) and is cleaned on reboot. The cleanup walker skips `hooks/` entirely. No manual cleanup required.

## Mandatory user-permission gate

**You MUST obtain explicit user approval via `AskUserQuestion` before writing the marker. This applies in every mode, including auto / yolo / non-interactive. No exceptions.**

The user has chosen to gate this skill behind explicit consent precisely so that bypassing the spelling rule is a deliberate, audited action — not a silent agent decision.

## Procedure

1. Determine `CLAUDE_SESSION_ID` from the runtime environment. If unset, fall back to `NOSESSION` — the hook uses the same fallback, so the bypass still takes effect, but warn the user that the disable is **not session-scoped** and will affect every session that lacks `CLAUDE_SESSION_ID` until the marker is removed.
2. Tell the user concretely what is being disabled and why you want to disable it (one sentence).
3. Call `AskUserQuestion` with a single question, two options:
   - **Disable for this session** — writes the marker, hook exits 0 until reboot or marker deletion.
   - **Keep enforcement on** — abort, no changes.
4. Only on explicit "Disable" answer:
   ```sh
   touch "$("$DG" stash -G hooks comment-disabled.$CLAUDE_SESSION_ID)"
   ```
5. Confirm to the user that the marker was written, including the path so they can `rm` it manually if they change their mind mid-session.

## Re-enabling

```sh
rm -f "$("$DG" stash -G hooks comment-disabled.$CLAUDE_SESSION_ID)"
```

Or wait for reboot (`$("$DG" stash -r)` cleared).

## When to suggest this skill

- A third-party name, quoted material, or proper noun legitimately carries a British spelling and cannot be changed — a dependency called `colour-convert`, a quoted statute, a person's name.
- The file reproduces text verbatim from an external source.

If the word is ours to choose, change it instead. The hook matches whole tokens, so it already ignores a British string inside a longer word.
