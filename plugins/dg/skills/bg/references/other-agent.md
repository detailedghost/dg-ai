# If you are any other agent

No Agent or Workflow tool exists, so detach a shell job through the CLI. It starts the command in its own session and process group. The job survives after this tool call's process group is torn down. A bare `&` would be reaped.

- **Launch:**

  ```sh
  ~/.dg/bin/dg-skills bg run '<command>' [--cwd <dir>]
  ```

  Pass the command as **one quoted argument**. A command split over several arguments is refused. It returns JSON: `{ id, logFile, statusFile, pidFile, launcherPid, state }`. Give the user the `id` and `logFile`.

- **A, shell command:** background it directly, for example `~/.dg/bin/dg-skills bg run 'npx nx test web'`.

- **B, agentic task:** background a proxy delegation to a real coding backend. Write the task to a file first, so quotes and `$` in it never reach the shell:

  ```sh
  ~/.dg/bin/dg-skills bg run '~/.dg/bin/dg-skills proxy <backend> --prompt-file "<task-file>"'
  ```

  `<backend>` is `codex`, `copilot`, `pi`, `opencode`, or `grok`. Use `grok` when the user asks for Grok Build. When the user names no backend, use `codex`.

  `~/.dg/bin/dg-skills proxy` on its own **blocks the caller until the backend finishes**. It streams to a log, but the invoking process waits. That is why it must be wrapped in `~/.dg/bin/dg-skills bg run` to run in the background. Another route: run `~/.dg/bin/dg-skills proxy <backend> --plan --prompt-file "<task-file>"` and execute the quoted `command` it prints.

- **C, multi-agent orchestration:** not available outside Claude Code. Split the work into independent `~/.dg/bin/dg-skills bg run` jobs (launch several, each checkable by id), or run the steps inline. Do not fake an orchestrator.
