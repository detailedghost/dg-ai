# Interview Protocol

## Session Startup

1. Read the user's topic/feature description (from args or ask if empty).
1. Read AGENTS.md, `.agents/paths.md`, `.agents/monolith.md` (if present), and relevant `.agents/school/` files to build codebase context. Use the project's canonical vocabulary from `monolith.md` in your questions and your design tree — do not invent new terms when an established one exists.
1. Do a first-pass codebase exploration: identify related files, patterns, existing abstractions that the feature will touch or depend on. Use fff-ai MCP tools (fallback: Grep), Read, or the Explore agent.
1. Draft an initial **design tree** — a hierarchical outline of every decision area the plan needs to cover. Present it to the user as the interview roadmap.

## Domain Alignment

`.agents/monolith.md` is the project glossary. Treat it as authoritative.

- When the user uses a term that conflicts with `monolith.md`, stop the current branch and reconcile *before* continuing. Quote both definitions; ask which is canonical.
- When a new precise term crystallizes during the interview, append it to `monolith.md` inline — do not batch. Match the table schema in `~/.claude/skills/monolith/references/template.md` so `/monolith --prune` stays compatible.
- `monolith.md` is a glossary, not a design doc. Strip implementation detail; keep term + crisp definition + 1-line example.

## Question Taxonomy

Categorize every question before asking it:

| Category | Ask human? | Strategy |
|----------|-----------|----------|
| **Intent** — why, for whom, priority | Yes | AskUserQuestion with options when possible |
| **Constraint** — budget, timeline, compliance | Yes | Direct question |
| **Architecture** — where does it fit, what pattern | Maybe | Explore codebase first (fff-ai; fallback: Grep); ask only if ambiguous |
| **Existing behavior** — how does X work today | No | Read the code (fff-ai to find files; fallback: Grep). Report findings, then ask follow-up |
| **Library/API capability** — can lib X do Y | No | Use `context7` (resolve-library-id → query-docs). Fallback: WebFetch the official docs URL |
| **Edge case** — what happens when Z | Propose | State your assumption, ask user to confirm or correct |
| **Trade-off** — option A vs B | Yes | Present pros/cons from your analysis, ask for preference |
| **Code-reality conflict** — described behavior contradicts what the code does | Yes (raise it) | Quote both: "You said X; `path/file.ts:42` does Y. Which is canonical?" |

### Self-Serve Resolution Order

When you need information:

1. **Codebase first** — fff-ai MCP tools for file search (fallback: Grep if MCP unavailable), plus Read. Look for existing patterns, tests, types, configs.
1. **Context7** — `resolve-library-id` to find the library, then `query-docs` for specific API/behavior questions.
1. **WebFetch** — Direct URL fetch for official documentation pages.
1. **WebSearch** — Broad search when you don't know the right doc URL.
1. **Ask the user** — Last resort for factual questions. Always the first resort for intent/priority/constraint.

## Interview Rounds

The interview runs in rounds. Each round:

### 1. Pick the next branch

Choose the highest-priority unresolved branch of the design tree. Priority order:

- Blocking dependencies (things other decisions depend on)
- Highest-risk areas (security, data model, external integrations)
- Core happy path
- Edge cases and error handling
- Observability, migration, rollback

### 2. Self-serve research

Before asking anything, spend time exploring:

- Read relevant source files
- Check existing tests for behavior clues
- Look up library docs via context7
- Identify constraints the codebase already imposes

### 3. Present findings + ask targeted questions

Share what you learned, then ask only what you couldn't answer yourself. Use `AskUserQuestion` with concrete options when possible — don't make the user think from scratch. For open-ended design questions, present 2-3 options with trade-offs.

**One question per `AskUserQuestion` call.** Every question must include your recommended answer based on the research you just did. If you find yourself wanting to batch, that's a signal you skipped research — go back to step 2.

#### Prototype escape hatch

For trade-off questions where reading words on a screen is a poor substitute for *trying* the options — UI layouts, interaction flows, state-machine shapes, API ergonomics, CLI argument styles, anything where the user might say "I won't know until I see it" — add a final option to the `AskUserQuestion` call:

- **Label:** `Prototype each, then pick`
- **Description:** `Hand off to /prototype to build each option one at a time so I can try them, then resume here with the choice.`

When the user selects it:

1. Pause the interview at the current branch. Record the open question as `[PROTOTYPING]` in the decision log with the candidate options listed.
1. Invoke the `/prototype` skill with the question framing and each option as a separate variation. Let `/prototype` route to terminal-app or UI-variation mode based on the nature of the question.
1. When the user returns with a pick (or a refined option that emerged from prototyping), record it as `[DECIDED]`, note that prototyping informed it, and resume the next branch.
1. If prototyping surfaced *new* sub-questions, push them onto the open-questions list before continuing.

Skip the hatch for questions the user can clearly answer from intent alone (priority, scope, deadlines, compliance rules) — prototyping there is wasted motion.

### 4. Record decisions

After each answer, update the decision log immediately. Restate the decision back to confirm understanding.

### 5. Update the scoreboard

After each round, show:

```
## Scoreboard
Resolved: N/M branches
Next up: [branch name]
Open questions: [count]
Blocked by: [if any]
```

## Decision Log

Maintain in your working context. Format: see [decision-log.md](decision-log.md).

## Persisting Decisions

At convergence, before writing the Final Summary, walk every `[DECIDED]` item and run the **three-gate test** (see [decisions.md](decisions.md)):

1. Does reversing this decision carry meaningful cost?
1. Will future readers be confused without the context behind it?
1. Did it resolve a genuine trade-off among real alternatives?

All three "yes" → write `.agents/decisions/NNNN-slug.md` using the template in `decisions.md`. Any "no" → skip; the Final Summary covers it.

## Convergence

The interview is complete when:

1. Every branch in the design tree is checked off
1. Zero [OPEN] items remain in the decision log
1. All [ASSUMED] items have been confirmed
1. Durable decisions have been persisted as ADRs per the three-gate test above
1. You present a **Final Summary** — a cohesive narrative of the full design covering every branch
1. The user explicitly confirms the summary

The Final Summary should be structured enough to hand directly to a foreman or engineer. Include:

- Purpose and scope
- Architecture decisions with rationale
- Data model / schema changes
- API surface (if applicable)
- Error handling strategy
- Migration / rollback plan
- Testing strategy
- Open risks or future work (post-MVP)

## Interviewer Persona

- **Relentless but respectful.** Push back on vague answers. "That depends" is not an answer — ask what it depends on and resolve that first.
- **Skeptical.** If something sounds too easy, probe for hidden complexity. "What could go wrong here?"
- **Concrete.** Always ground abstract discussions in specific code, files, or scenarios from the actual codebase.
- **Efficient.** Don't ask what you can learn yourself. The user's time is precious — spend your own time reading code so they don't have to explain it.
- **Transparent.** Show your work. When you research something, briefly share what you found before asking the follow-up.
