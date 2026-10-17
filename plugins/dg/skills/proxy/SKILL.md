---
name: proxy
description: Delegate a coding task to an installed CLI agent (codex, copilot, pi, opencode, cortex, or grok), with persona, resume, and background support.
---

# Proxy

Resolve the compiled CLI before invoking it:

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

Run the backend in the caller's native background task when that facility exists:

```bash
"$DG" proxy <backend> --prompt "<task>" [flags]
```

For a terminal or caller without native background tasks, prepare a plan:

```bash
"$DG" proxy <backend> --plan --prompt-file "<task-file>" [flags]
```

This writes the fully briefed prompt and prints JSON containing the exact quoted background `command`. Execute that command to launch the job; do not reconstruct it from its parts. It returns a job record with `id`, `logFile`, and `statusFile`. The backend runs detached, so the launch returns promptly. Inspect it with:

```bash
"$DG" proxy background status "<id>"
"$DG" proxy background list
```

Read the completed job's log for the final proxy JSON result. Use `"$DG" proxy background update "<id>" "<context>"` to queue context while a job runs or resume its completed backend session; `cancel "<id>"` stops the owned job. Resumed executions use the same native or packaged background pattern. A resume repeats the job's `--model` and `--effort`. If the automatic resume fails, `status` shows its output in `drainOutput`. `background run` takes the whole command as one quoted argument.

The packaged background pattern proves a job's identity from its Linux `/proc` start time. On other platforms it fails closed: `status` reports the job as `unknown`, and `cancel` returns `no-pid` without signaling any process.

## Flags

| Flag | Behavior |
|---|---|
| `--list-backends` | List all six registered backend identities without running one |
| `--prompt` | Supply the task directly; takes precedence over `--prompt-file` |
| `--prompt-file` | Read the task from a file, keeping large prompts out of argv |
| `--model` | Override the backend model |
| `--effort` | Override its reasoning or thinking effort |
| `--subagent` | Brief the backend with the named configured agent persona |
| `--spec` and `--slice` | Resolve the persona from an explicit plan file's assigned primary agent |
| `--cwd` | Choose the backend's working directory |
| `--resume` | Continue an existing session without reinjecting its persona |
| `--plan` / `-p` | Resolve the persona, save the briefed prompt, and print a launch command without running the backend |

The task must use `--prompt` or `--prompt-file`; a positional task is not accepted. Set `DG_PERSONAS_DIR` (or `DG_AGENTS_DIR`) to relocate agent persona Markdown files; lookup retains the existing personal agent-directory fallback. Planning always resolves the persona and emits a fresh execution, including when `--resume` was supplied to the planning call. For a session continuation, pass `--resume` to an actual execution.

## Backend skills

Resolve each requested skill from the installed dg skill tree relative to this skill directory (`../<name>/SKILL.md`), then pass that real absolute path to the backend. An explicit configured personal skill root may supply an unmigrated skill. Never assume a private source checkout or installed cache layout. Tell the backend to read the named skill and follow its lazy reference links as needed; it must report a missing file rather than invent its behavior.

The CLI's shared resource locator accepts `DG_SKILLS_DIR` for a relocated canonical skill tree. Its source and installed defaults use real filesystem paths.

## Plan output

A plan prints `{plan: true, backend, planFile, command}` on stdout. Progress goes to stderr: the saved plan path, the launch command, and a note when the selected backend is not installed yet. Planning still succeeds in that case so the user can install it before launch. The emitted command leaves out `--subagent`, `--spec`, and `--slice`; the plan file already contains their resolved briefing.

## Result handling

Apply these rules after the background task completes, with at most five resume or retry round trips:

1. Exit 1 with `backend`, `bin`, and `installCommand`: the selected backend is missing. Show its installation guidance and stop. Do not retry or switch backends automatically.
2. `exitCode: 0` with completed work in `message`: summarize the result and stop.
3. `exitCode: 0` with a clarifying question: answer from known context or ask the user, then resume that `sessionId` with the answer.
4. A nonzero result with `likelyCause: "model"` or `"effort"`: ask whether to retry using defaults, another value, or abort. Do not change it silently.
5. Another nonzero result: show `stderrTail` and `logFile`, then stop. A setup failure instead returns `{exitCode, error}` without a log path; show that error and stop.

The complete backend stdout transcript remains in `logFile`. A successful execution returns `{sessionId, message, logFile, exitCode: 0}`. Keep these paths available for inspection and later resumes.
