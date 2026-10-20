# Hunt Protocol

## Phase 1 — Triage (in-conversation, no agents)

Classify the issue before launching anything. Read the user's description and answer:

1. **Domain** — which area of the stack? (database, CI/pipeline, application logic, infrastructure, security, tests, build)
1. **Scope** — single file, single service, cross-cutting?
1. **Reproducibility** — always fails, intermittent, environment-specific?
1. **Evidence available** — error message, log output, failing test, or just "it broke"?

If evidence is thin, do a quick in-conversation pass first:

- `mcp__fff__grep` for the error message or key identifier
- `git log --oneline -20` on the affected path
- Read the most likely source file

This often resolves simple issues without agents. If it does — report and stop.

## Phase 2 — Plan Investigation Threads

Break the investigation into **independent threads** that can run in parallel. Each thread is a focused question with a clear deliverable.

### Thread Design Rules

- **Max 3 threads.** More than 3 means your triage was too vague — narrow the scope.
- **No overlap.** If two threads would read the same files, merge them.
- **Each thread gets one job.** "Find where X is defined and how it's called" is one thread. "Find X and also check if Y is related" is two threads crammed together — split or pick the more important one.
- **Threads must be self-contained.** The agent prompt includes everything needed — file paths, error text, what to look for, what to report back. No "based on your findings" delegation.

### Agent Routing

Pick the agent type that matches the thread's domain:

| Domain | Agent type | When |
|--------|-----------|------|
| Database schema, queries, migrations | `dba` | Schema mismatch, query failure, migration issue |
| CI/CD, pipeline, build, deploy | `qa-devops` | "Fails on the pipeline", build errors, deploy issues |
| Test failures, logic correctness | `reviewer` | Wrong output, assertion failures, coverage gaps |
| Security, auth, access control | `security` | Permission errors, token issues, vuln investigation |
| Python runtime, library issues | `python` | Python stack traces, import errors, dependency issues |
| JS/TS runtime, bundling, React | `js` | JS errors, build tool issues, frontend bugs |
| C#/.NET runtime issues | `csharp` | .NET exceptions, EF Core issues |
| Shell/infra/environment | `shell` | Path issues, permissions, env var problems |
| General codebase exploration | `Explore` | Domain unclear, or need broad file discovery |

**Default to `Explore` only when no domain-specific agent fits.** Domain agents carry expertise that Explore doesn't. These domain agent types come from the user's own setup, not from this plugin. When the type is not installed, use `general-purpose` for the thread.

### Agent Prompt Template

Every agent prompt must include:

```
Context: [1-2 sentences on the overall issue]
Your task: [specific question this thread answers]
Known so far: [findings from triage, file paths, error text]
Look at: [specific files/dirs to start with]
Report: [what format — file paths, root cause, evidence. Under N words.]
```

Always append: *"If `.agents/monolith.md` exists, read it first — use the project's canonical terms in your report and avoid the listed aliases."* Skip if no `.agents/monolith.md` is present in the repo.

Keep prompts under 200 words. The agent doesn't need the full story — it needs its specific assignment.

### Dispatch (Workflow)

When there are **2+ independent threads**, dispatch them as a background **Workflow** instead of hand-launching agents — invoking `/dg:hunt` is the opt-in. For a single thread, just call the agent inline; a workflow adds no value.

Build `threads[]` (`{ id, agentType, prompt }`) from the routing table + prompt template above, then:

```
Workflow({
  scriptPath: "<skills>/hunt/references/hunt.workflow.mjs",
  args: {
    threads,                       // ≤3
    monolithHint: "<the monolith.md line, or ''>",
    verify: true                   // adds the adversarial Verify stage below
  }
})
```

`args` contract: `threads` is `[{ id, agentType, prompt }]`, each self-contained; the script keeps only the first 3. `monolithHint` is appended to every prompt, or `''` when there is no `monolith.md`. `verify` defaults to `true`.

Threads carry an optional `model` (the script pins `security`/`dba` → opus, all other domains → sonnet, and Verify → sonnet, since unpinned workflow agents would inherit the session Opus). The script runs each thread (`Investigate`) then, by default, an adversarial **Verify** pass: a skeptic re-opens the cited lines and returns `confirmed: true|false`. It returns `{ findings: [{ threadId, rootCause, evidence, confidence, needsDesignDecision, verified }] }`. Every finding carries its `threadId`. `verified` is `null` when `verify` is `false`, and `{ confirmed: false, note: "verifier failed" }` when the verifier agent fails. Structured output — the orchestrator never parses prose. Set `verify: false` only for a fast, low-stakes pass.

## Phase 3 — Synthesize

Working from the workflow's `findings` (or in-conversation investigation for single-thread/trivial hunts):

1. **Cross-reference** findings from all threads. Do they converge on the same root cause? Contradict?
1. **Trust the verdicts.** A finding with `verified.confirmed: false` is a refuted hypothesis — demote or drop it; don't lead the diagnosis with it.
1. **Fill gaps** — if one thread found the "what" but not the "why", do a targeted follow-up read in-conversation. Don't launch another agent for one file read.
1. **Final read** — for the surviving root cause, read the actual lines yourself before committing to the report. The Verify stage is a filter, not a substitute for your own confirmation on the decisive path.

## Diagnosis Report

Present findings in this format:

```markdown
## Diagnosis: [one-line summary]

**Root cause:** [2-3 sentences with file:line references]

**Evidence:**
- [file:line] — [what it shows]
- [git SHA or log entry] — [what it shows]
- [error message] — [what it means]

**Impact:** [what breaks, who's affected, severity]

**Recommended fix:** [concrete steps, not vague advice]

**Confidence:** [high/medium/low] — [why]
```

### Confidence Levels

- **High** — Root cause confirmed by reading the code path end-to-end. Fix is clear.
- **Medium** — Strong hypothesis supported by evidence, but couldn't fully reproduce or trace the complete path. Fix is likely correct.
- **Low** — Multiple possible causes. Need more information (logs, reproduction, environment access). List the candidates ranked by likelihood.

## When to Escalate to /dg:grill-me

If the investigation reveals that the fix requires **design decisions** the user hasn't made:

- New behavior that doesn't exist yet
- Trade-offs between multiple valid approaches
- Scope questions (fix the symptom vs. fix the architecture)

Say so explicitly: *"Root cause identified. The fix requires a design decision — recommend `/dg:grill-me` to work through [specific question]."*

Don't try to make design decisions during investigation. Diagnose, then hand off.

## Token Budget

Target the full investigation (triage + agents + synthesis + report) at:

- **Simple** (single file, clear error): 0 agents, ≤5 tool calls
- **Medium** (cross-file, unclear cause): 1-2 agents, ≤15 tool calls total
- **Complex** (cross-service, multiple suspects): 2-3 agents, ≤25 tool calls total

If you're past these numbers without convergence, stop and report what you know with confidence: low.
