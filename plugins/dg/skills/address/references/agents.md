# Agent Roster

## Selectable (Phase 2c)

| Agent | Domains |
|------------|--------------------------------------------|
| `js` | JavaScript, TypeScript, React, Next.js, Node.js, CSS |
| `csharp` | .NET, EF Core, NUnit, XUnit |
| `python` | Flask, SQLAlchemy, Snowflake, pandas, dlt, boto3, pytest |
| `dba` | Schema, queries, migrations, indexing, Snowflake |
| `security` | Vuln fixes, auth, secrets, hardening |
| `shell` | Shell scripts, POSIX sh, Bash/ZSH configs |
| `devops` | GitHub Actions, Dockerfiles, Terraform, AWS, CI/CD |
| `qa-writer`| Tests |
| `lore` | Docs, READMEs, code comments, Mermaid |

## Common Directives (all agents)

Inject into every fix-agent prompt:

- **Project vocabulary:** Read `.agents/monolith.md` if it exists (skip if missing). Use the project's canonical terms in code, comments, and the `summary` field of your JSON response. Avoid the listed aliases.

## Response Format (all agents)

Agents receive work items as JSON and must return results as JSON — never prose, never files.

- **Phase 2b** (qa-writer): `[{"commentId": N, "tested": bool, "reason": "..."}]`
- **Phase 2c** (fix agents): `[{"commentId": N, "summary": "one-line what changed"}]`
- **Phase 3** (QA agents): `[{"file": "path", "line": N, "severity": "critical|high|medium|low", "issue": "..."}]` or `[]` if clean.

This keeps data machine-readable through the entire pipeline. The orchestrator joins results by `commentId` — no text parsing.

## Agent-Set Selection

See `workflow.md` Phase 1b. Summary:

- 1-2 agents via `-a` (or bare args): use as-is.
- 0 agents OR 3+ agents: `foreman` (on `sonnet`) auto-detects.

## File-Extension Routing (item → agent)

After the agent set is fixed, route each work item to one of the selected agents by path:

| Match | Agent |
|---|---|
| `.cs`, `.csproj` | `csharp` |
| `.tsx`, `.jsx`, `.css` | `js` |
| `.ts`, `.js`, `.mjs`, `.cjs` | `js` |
| `.py` | `python` |
| `.sql`, `.migration` | `dba` |
| `.sh` | `shell` |
| `.yml`/`.yaml` under `.github/`, `Dockerfile`, `.tf` | `devops` |
| `.gitlab-ci.yml` (exact, root-only) | `devops` |
| `*.test.*`, `*.spec.*` | `qa-writer` |
| `*.md`, `docs/**` | `lore` |

The `.gitlab-ci.yml` row is an exact filename match at the repo root, not a directory-prefix rule like the `.github/` row above. A relocated config file or one split via `include:` into other files is out of scope — only the root `.gitlab-ci.yml` itself is routed.

Overrides:

- Comment body matches `auth|crypt|secret|token|cve` (case-insensitive) → also assign `security`.
- File matches both `shell` and `devops` (e.g. `Dockerfile`) → prefer `devops`.
- No matching agent in selected set → route to closest match, else `general-purpose`.
- Non-overlapping files → run agents in parallel.

## QA Agents (Phase 3, always)

- `reviewer` — quality, correctness, coverage, logic
- `qa-devops` — build, tests
- `qa-perf` — hotspots, allocs, async, queries

## Support Agents

- `wave` — combined light review + correctness + checkpoint audit
