# If you are Claude Code

Use the native primitive. It gives completion notifications and context isolation that a detached shell job cannot. Do **not** call `~/.dg/bin/dg-skills bg` here.

- **A, shell command:** Bash tool with `run_in_background: true`. Tell the user the shell id. Check progress later with BashOutput.
- **B, agentic task:** Agent tool with `run_in_background: true` and the best-fit `subagent_type`. It runs detached and notifies you on completion. Relay the result to the user when it lands.
- **C, multi-agent orchestration:** the **Workflow** tool. **Gated: use it only when the task is truly multi-agent and the user opted in** (passed `-w` or `--workflow`, or clearly asked for orchestration). A Workflow can spawn many agents and burn a large token budget, and the harness gates it behind explicit opt-in. If the task is big but not truly multi-agent, or the user did not opt in, use a single background **Agent** instead and say that you did.

When unsure between B and C, choose B (one background Agent). It is the cheaper and more reversible move. You can escalate to a Workflow later, but you cannot un-spend its token budget.
