# Escalation

Escalation applies to picks, not just effort: work doesn't need an `opus`-tier primary just because one hard call lives
inside it. Give it the right-sized primary and let `qa` carry the escalation — e.g. `primary: shell` + `qa: [security]`
for mostly-mechanical work with one auth-adjacent line. Don't upgrade the whole primary/effort to cover a single hard
call.

This works cleanly when the hard call is *detection/judgment* — the higher-tier `qa` agent flags it, the primary applies
the fix. It's a weaker fit when the hard call is *implementation itself* (e.g. a security-sensitive algorithm, not just
a security-sensitive line) — a `sonnet` primary can burn both correction rounds re-attempting a fix a `dg:security`/`opus`
reviewer keeps rejecting, surfacing only as a deferral at the end. If the hard part is something only a higher-tier
agent could *write*, not just *catch*, give it that agent as `primary` instead of routing it through `qa`.

## Optional: delegating a slice externally

Spec mode only — there is no frontmatter to record it in otherwise.

`/dg:assign` does not automatically decide when to delegate a slice to an external CLI backend via `/dg:proxy`
(codex/copilot/pi/opencode/cortex/grok) — that's a cost/trust decision, not a content-matching pick like `dg:js` vs `dg:shell`.

Only write `agents.proxy: <backend>` when the user explicitly asks for a slice (or the whole spec) to be delegated
externally during this invocation (e.g. "delegate the migration slice to codex").

Validate the backend name by running `~/.dg/bin/dg-skills proxy --list-backends` — not the
agent roster check the common steps use, since codex/copilot/pi/opencode/cortex/grok aren't Claude agents. The
name must be one of that command's output lines. Mismatch → refuse to write, list the valid names (same failure-mode
style as an agent-name typo).

`agents.primary` keeps meaning exactly what it means today — the persona `/dg:proxy` briefs the external backend with via
`--subagent`. `agents.proxy` is a separate execution-mode axis layered on top, not a replacement.

## Failure modes

A missing spec file is not one of them — no spec is the default path.

- Path-shaped argument with no such file → stop, print the path (dispatch rule 3).
- Agent name typo'd into a pick → refuse, list valid names.
- `proxy` backend name typo'd (not in `~/.dg/bin/dg-skills proxy --list-backends` output) → refuse, list valid names.
- `--dry-run`/`--force` with no spec path → stop, they have no meaning outside spec mode.

Spec mode only:

- Spec file unreadable → stop, print path.
- Frontmatter unparseable → stop, do not guess.
- No `slices[]` array in frontmatter → stop, this isn't a `/dg:spec` spec.
- Uncommitted spec changes + manual invocation → warn but proceed (the user asked for it).
