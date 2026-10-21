# Agent Roster

## Selectable (Phase 2c)

| Agent | Domains |
|------------|--------------------------------------------|
| `dg:js` | JavaScript, TypeScript, React, Next.js, Node.js, CSS |
| `dg:csharp` | .NET, EF Core, NUnit, XUnit |
| `dg:python` | Flask, SQLAlchemy, Snowflake, pandas, dlt, boto3, pytest |
| `dg:dba` | Schema, queries, migrations, indexing, Snowflake |
| `dg:security` | Vuln fixes, auth, secrets, hardening |
| `dg:shell` | Shell scripts, POSIX sh, Bash/ZSH configs |
| `dg:devops` | GitHub Actions, Dockerfiles, Terraform, AWS, CI/CD |
| `dg:qa-writer`| Tests |
| `dg:lore` | Docs, READMEs, code comments, Mermaid |

## Common Directives (all agents)

Inject into every fix-agent prompt:

- **Project vocabulary:** Read `.agents/monolith.md` if it exists (skip if missing). Use the project's canonical terms in code, comments, and the `summary` field of your JSON response. Avoid the listed aliases.

## Response Format (all agents)

Agents receive work items as JSON and must return results as JSON — never prose, never files.

This file is the single schema. `id` is the item's `commentId`, `localId`, `ciId`, or Wiz `findingId`.

- **Phase 2b** (qa-writer): `[{"id": ID, "tested": bool, "reason": "..."}]`
- **Phase 2c** (fix agents): `[{"id": ID, "status": "fixed|blocked", "summary": "one-line what changed"}]`
- **Phase 3** (QA agents): `[{"file": "path", "line": N, "severity": "critical|high|medium|low", "issue": "..."}]` or `[]` if clean. The prompt overrides the persona's own report format; the agent maps its severity labels to these four values.

This keeps data machine-readable through the entire pipeline. The orchestrator joins results by `id` — no text parsing.

## Agent-Set Selection

See `workflow.md` Phase 1b. Summary:

- 1-2 agents via `-a` (or bare args): use as-is.
- 0 agents OR 3+ agents: `dg:foreman` (on `sonnet`) auto-detects.

## File-Extension Routing (item → agent)

After the agent set is fixed, route each work item to one of the selected agents by path. The first matching row wins, top to bottom:

| Match | Agent |
|---|---|
| `*.test.*`, `*.spec.*` | `dg:qa-writer` |
| `.yml`/`.yaml` under `.github/`, `Dockerfile`, `.tf` | `dg:devops` |
| `.gitlab-ci.yml` (exact, root-only) | `dg:devops` |
| `*.md`, `docs/**` | `dg:lore` |
| `.cs`, `.csproj` | `dg:csharp` |
| `.tsx`, `.jsx`, `.css` | `dg:js` |
| `.ts`, `.js`, `.mjs`, `.cjs` | `dg:js` |
| `.py` | `dg:python` |
| `.sql`, `.migration` | `dg:dba` |
| `.sh` | `dg:shell` |

The `.gitlab-ci.yml` row is an exact filename match at the repo root, not a directory-prefix rule like the `.github/` row above. A relocated config file or one split via `include:` into other files is out of scope — only the root `.gitlab-ci.yml` itself is routed.

Overrides:

- Comment body matches `\b(auth|authz|crypto|secret|token|cve)\b` (case-insensitive) → also assign `dg:security`.
- No matching agent in selected set → route to closest match, else `general-purpose`.
- Non-overlapping files → run agents in parallel.

## QA Agents (Phase 3, always)

- `dg:reviewer` — quality, correctness, coverage, logic
- `dg:qa-devops` — build, tests
- `dg:qa-perf` — hotspots, allocs, async, queries

## Support Agents

- `dg:wave` — combined light review + correctness + checkpoint audit
