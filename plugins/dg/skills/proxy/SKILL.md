---
name: proxy
description: Delegate a coding task to an installed CLI agent (codex, copilot, pi, opencode, or grok), with persona, resume, and background support.
---

# Proxy

Resolve the compiled CLI before invoking it:

```bash
~/.dg/bin/dg-skills bg --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.2/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor bg proxy.

Run the backend in the caller's native background task when that facility exists:

```bash
~/.dg/bin/dg-skills proxy <backend> --prompt-file "<task-file>" [flags]
```

Write the task to the file first, so quotes, `$`, and backticks in it never reach the shell.

For a terminal or caller without native background tasks, prepare a plan:

```bash
~/.dg/bin/dg-skills proxy <backend> --plan --prompt-file "<task-file>" [flags]
```

This writes the fully briefed prompt and prints JSON containing the exact quoted background `command`. Execute that command to launch the job; do not reconstruct it from its parts. It returns a job record with `id`, `logFile`, and `statusFile`. The backend runs detached, so the launch returns promptly. Inspect it with:

```bash
~/.dg/bin/dg-skills bg status "<id>"
~/.dg/bin/dg-skills bg list
```

Read the completed job's log for the final proxy JSON result. Use `~/.dg/bin/dg-skills bg update "<id>" "<context>"` to queue context while a job runs or resume its completed backend session; `~/.dg/bin/dg-skills bg cancel "<id>"` stops the owned job. Resumed executions use the same native or packaged background pattern. A resume repeats the job's `--model` and `--effort`. If the automatic resume fails, `~/.dg/bin/dg-skills bg status "<id>"` shows its output in `drainOutput`. `~/.dg/bin/dg-skills bg run` takes the whole command as one quoted argument. See [the bg skill](../bg/SKILL.md) for job management.

The packaged background pattern proves a job's identity from its Linux `/proc` start time. On other platforms it fails closed: `~/.dg/bin/dg-skills bg status "<id>"` reports the job as `unknown`, and `~/.dg/bin/dg-skills bg cancel` returns `no-pid` without signaling any process.

## Flags

**Usage:** `/dg:proxy <backend> (--prompt <text> | --prompt-file <path>) [--model <name>] [--effort <level>] [--subagent <name>] [--cwd <dir>] [--resume <session>] [--plan | -p]`

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--list-backends` | none | List all five registered backend identities without running one. | off |
| `--prompt <text>` | none | Supply the task directly. Takes precedence over `--prompt-file`. | none |
| `--prompt-file <path>` | none | Read the task from a file, keeping large prompts out of argv. | none |
| `--model <name>` | none | Override the backend model. | backend default |
| `--effort <level>` | none | Override its reasoning or thinking effort. | backend default |
| `--subagent <name>` | none | Brief the backend with the named configured agent persona. | none |
| `--spec <path>` and `--slice <id>` | none | Resolve the persona from an explicit plan file's assigned primary agent. | none |
| `--cwd <dir>` | none | Choose the backend's working directory. | current directory |
| `--resume <session>` | none | Continue an existing session without reinjecting its persona. | off |
| `--plan` | `-p` | Resolve the persona, save the briefed prompt, and print a launch command without running the backend. | off |

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
