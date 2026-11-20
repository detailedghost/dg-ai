---
covers: ["pkg/channel-review/src/runners/**", "pkg/channel-review/src/config.ts", "pkg/channel-review/src/automation/fix-flow.ts"]
---

[ADR 0012](../../docs/adr/0012-runner-boundaries.md)

- Invoke the Claude runner with `claude -p`, noninteractive permission settings and a task-specific `--allowedTools` list.
- Never share one tool list across tasks.
- Filter the child environment: remove the Claude nesting and control variables. Keep the OAuth token for the Claude task.
- Tell the runner not to commit or push for error fixes. Let channel review commit, check the branch against the expected and default branches, push and open a draft PR.
- Treat Codex, Copilot and Grok review runners as experimental. Never present them as supported.
- Never treat a tool allowlist as an OS sandbox or push sandbox.
- Never embed a runner SDK in place of the installed CLI.
