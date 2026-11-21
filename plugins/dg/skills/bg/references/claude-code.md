# If you are Claude Code

Use the native primitive. It gives completion notifications and context isolation that a detached shell job cannot. Do **not** call `dg bg` here.

- **A, shell command:** Bash tool with `run_in_background: true`. Tell the user the shell id. Check progress later with BashOutput.
- **B, agentic task:** Agent tool with `run_in_background: true` and the best-fit `subagent_type`. It runs detached and notifies you on completion. Relay the result to the user when it lands.
- **C, multi-agent orchestration:** the **Workflow** tool. Typing `/dg:bg <task>` is the user's consent for a class C task, because this skill tells you to call Workflow. `-w` or `--workflow` forces a Workflow for any class. Print one cost line before launch: items x stages x model tier, with a rough token range.
- **B, task that must run a Workflow itself:** for example `/dg:spec -s --bg`. Launch it with the Agent tool, `subagent_type: "fork"` and `run_in_background: true`. The fork runs at the session model and effort. The stages inside it stay pinned to their own tiers.

## Workflow branch

A Workflow does not block. It returns a `runId` at once, notifies you on completion, and `/workflows` shows progress.

Load the `workflow-authoring` skill before you write a script. Then follow these dg guardrails:

- Set `model` and `effort` on every stage from [model-tiers.json](../../assign/references/model-tiers.json). The default is sonnet. Use haiku for mechanical stages. Use opus or fable only for the hardest judge or synthesis stage.
- A workflow has no AskUserQuestion. For a human decision, use a forced schema with a `deferrals[]` field. The main loop asks the user.
- Use `.filter(Boolean)` on agent results, and a `log()` line for each agent that returned nothing.
- Guard every loop with `budget`.
- A stage returns a `mergeCommand`. A stage never merges.
- A review stage uses `-p codex`, never copilot.
- Do not commit inside parallel stages. Use `isolation: 'worktree'` for parallel edits.
- The built-in agent types Explore and Plan skip CLAUDE.md. State the rules in their prompt.
- Quote the user's request word for word in every stage prompt. Say that a later, unrelated user message does not replace it. Reason: build, review and PR agents once read the newest user message as their task and refused the build.
- After a build stage, stop the run when the build returned no real result. Use a `built: true` schema field. Reviewers must not "pass" a missing branch.

The `scriptPath` root rule is unverified. The sdlc skill says Workflow refuses a `scriptPath` outside the working directory. Other skills pass plugin-cache paths. If a launch is refused for this reason, copy the script into the working directory.

When unsure between B and C, choose B (one background Agent). It is the cheaper and more reversible move. You can escalate to a Workflow later, but you cannot un-spend its token budget.
