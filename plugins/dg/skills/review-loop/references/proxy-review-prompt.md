<!-- markdownlint-disable MD013 MD033 MD041 MD060 -->

# Launching the Proxy Review Backend

Read this only when Proxy-Mode Workflow Phase 3 fires (see
[proxy-workflow.md](proxy-workflow.md)). The recipient is an
**external CLI coding agent** run via `/dg:proxy`.
It starts with zero conversation context and has its own command and file tools, so the prompt below must be fully self-contained.

## Invocation

```bash
~/.dg/bin/dg-skills proxy <backend> --prompt-file <absolutePromptPath>
```

Read [../../proxy/SKILL.md](../../proxy/SKILL.md) for its
background execution contract: use the host's native background task when
available, otherwise request `--plan` and execute its exact emitted `command`.
Use `~/.dg/bin/dg-skills bg status <id>` to inspect a packaged background job.
Do not pass `--subagent`/`--spec` — this is a one-off review task.

## Prompt Template

```text
You are reviewing a git diff as a senior engineer doing an
antagonistic code review — treat every change as guilty until proven
correct. Read only what you need; do not explore the codebase beyond
what the diff touches and the narrow context around each changed line.

Diff (base..HEAD) is in this file; read it first:
<absolute path of the diff file>

For each real issue you find — correctness bugs, security flaws,
resource leaks, broken contracts, dead code introduced by this diff,
or clearly wrong logic — write ONE finding. Do not flag pure style
preferences, formatting, or anything you're not confident is a real
defect: false positives cost a human's time down the line, and this
output is filtered before anyone reads it.

Write your findings to this exact path, creating the parent directory
if needed:

  <reviewFile absolute path>

Format — one section per finding, e.g.:

  ## <path>:<line>

  severity: <low|medium|high|critical>

  <one paragraph: what's wrong, why, and the concrete failure case>

If you find nothing worth flagging, do NOT create the file at all (or
leave it empty if you already created it) — an empty/absent file
means "no findings" to the caller. Do not touch any file other than
<reviewFile absolute path>. Do not attempt to fix anything yourself —
you are reviewing, not editing.
```

Fill in `<absolute path of the diff file>` and `<reviewFile absolute path>`
before writing the prompt file. Always write the diff to a scratch file under
`$(~/.dg/bin/dg-skills stash review-loop)/` and write the filled template to a second
scratch file; never put either in a shell string.

## Finding Format Contract

The format above matches what `/dg:address` Phase 1c
([../../address/references/workflow.md](../../address/references/workflow.md)) already parses out of
`.agents/code-review/*.md` — `path`, `line`, `body`, `severity`. Do not
invent a different shape; `/dg:address`'s local-review ingestion is the
only consumer.

## Result Handling After Return

Follow `/dg:proxy`'s own result-handling rules ([../../proxy/SKILL.md](../../proxy/SKILL.md#result-handling))
verbatim — backend installation guidance, success, clarifying question, `model`/`effort`
error, `other` error. This file only supplies the review-specific
prompt content; pass real resolved absolute paths to the backend, never literal
shell substitutions. The background-invoke and result-handling mechanics
are `/dg:proxy`'s, not reimplemented here.

After a successful return, Proxy-Mode Workflow Phase 4 decides
close-out vs. hand-off to `/dg:address` based on whether `reviewFile`
exists and is non-empty — this file's job ends once the prompt has
been sent.
