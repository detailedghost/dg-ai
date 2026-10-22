---
name: bg
description: Run a task in the background so you can keep working, for any agent. Picks the right background primitive for the runtime. Claude Code uses a background Agent or Bash, or an opt-in Workflow. Any other CLI agent detaches a shell job through the dg CLI. Triggers on "do this in the background", "kick this off while I keep going", "background this", `/dg:bg <task>`.
---

# /dg:bg: Run This In The Background

One verb for "do this work in the background and let me keep going." The work runs off to the side. You, the foreground agent, stay free and report back how to check on it. You never block while it runs.

The mechanism differs by runtime. `/dg:bg` picks it for you: detect the runtime, classify the task, launch on the matching primitive, tell the user how to check back.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills bg --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.19.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor bg proxy.

## Usage

**Usage:** `/dg:bg <task or shell command> [-w|--workflow]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--workflow` | `-w` | Opt in to a multi-agent Workflow for work with several roles that fan out and then synthesize. Claude Code only; see [references/claude-code.md](references/claude-code.md). | off (one background agent) |

Everything up to a flag is the task. It is either a natural-language task ("investigate the flaky auth test and summarize the cause") or a literal shell command ("npx nx test web").

Managing a launched job (see [references/job-management.md](references/job-management.md)):

- `~/.dg/bin/dg-skills bg cancel <id>` (alias `~/.dg/bin/dg-skills bg kill <id>`) stops a running background job.
- `~/.dg/bin/dg-skills bg update <id> '<context>'` feeds more context into an in-flight or finished agentic job.
- `~/.dg/bin/dg-skills bg prune --cwd <dir>` drops the records of finished jobs for a directory tree. `/dg:cls` calls it when it removes a worktree. Live jobs are reported, never killed.

## The decision (runtime-independent)

**1. Classify the task:**

- **A: Shell command or long process.** A build, test run, script, or data pull. It has a command line and an exit code.
- **B: Agentic task.** It needs a model to reason, read code, edit, or investigate. It reads as an instruction, not a command.
- **C: Multi-agent orchestration.** Several roles with dependencies or waves (fan-out, then synthesis). Rare. Most big tasks are still one background agent.

**2. Detect your runtime:**

- You have the **Agent** and **Workflow** tools: you are **Claude Code**. Read [references/claude-code.md](references/claude-code.md).
- Otherwise (codex, copilot, pi, opencode, grok, or anything else) read [references/other-agent.md](references/other-agent.md). Grok Build has `spawn_subagent` and a workflow tool. It is not Claude Code. Use the same path.

**3. Launch, then report how to check back. Do not block.** Print the handle (background shell id, agent notification, or `bg` job id and log path). Return control to the user at once.

## Routing

| Task | Read |
|---|---|
| Pick the launch primitive as Claude Code (Agent and Workflow tools available) | [references/claude-code.md](references/claude-code.md) |
| Launch as any other CLI agent (codex, copilot, pi, opencode, grok) through `~/.dg/bin/dg-skills bg` | [references/other-agent.md](references/other-agent.md) |
| Check status, read logs, or cancel and update a running job | [references/job-management.md](references/job-management.md) |

## Guardrails

- **Do not background what needs a human mid-flight.** No interactive prompts (stdin) and no destructive one-offs the user has not confirmed. Background work runs unattended.
- **Reversibility first.** Prefer a single background agent or job over a Workflow until orchestration is clearly needed. One job is easy to cancel. A fan-out is not.
- **One verb, three substrates.** You pick the mechanism from the task and the runtime. The user types `/dg:bg <task>`.
