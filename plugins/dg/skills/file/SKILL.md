---
name: file
description: File, list, and organize an issue on the current repo's git provider (GitHub or GitLab) — bugs, tech debt, follow-ups tied to the codebase itself. Use when the user says "file an issue", "open a GitHub/GitLab issue", "track this as a bug", "what issues are open", or /dg:file. Not for Jira project-planning tickets — that's /ticket.
---

# /dg:file — File a Git-Provider Issue

## Runtime and skill paths

Resolve the compiled CLI before running any command:

```bash
~/.dg/bin/dg-skills file --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.17.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor file proxy.

Repeat this resolution in every fresh shell, including resumed and delegated
commands; shell variables do not persist between tool calls. Use the host's
existing narrow approvals for the operation and honor permission already granted
in this session. Do not edit permission files or assume the compiled binary grants
blanket approval to its subcommands.

Resolve cross-skill instructions from this installed tree using sibling paths
(`../<skill>/SKILL.md` from this directory). If an unmigrated skill is missing, use
only an explicitly configured personal skill root
(`DG_PERSONAL_SKILLS_DIR/<skill>/SKILL.md`). Report missing instructions rather
than assuming a private checkout or cache location. If delegating, resolve host
personas through the host registry or explicit `DG_PERSONAS_DIR` / `DG_AGENTS_DIR`
configuration, and pass real absolute instruction paths to delegates.
The plugin ships its personas in `agents/` (Claude Code loads them as
`dg:<name>`; `dg-skills proxy` embeds them), so use those when the host has none.

Run commands through the compiled CLI:

```bash
~/.dg/bin/dg-skills file <subcommand> [flags]
```

The shared VCS provider layer uses `gh` or `glab`, detected from the current
repository's `origin`. Both providers support every subcommand below. Run
`~/.dg/bin/dg-skills file --help` for the full usage.

## /dg:file vs /ticket

| Signal | Skill | Why |
|---|---|---|
| "File a bug / track this in the repo's issue tracker" | `/dg:file` | GitHub Issues or GitLab Issues, tied to this codebase |
| "Make a ticket / plan this as a story or task" | `/ticket` | Jira project-planning and sprints |
| Unsure which | `/dg:file` | Cheaper default — a repo issue can always be linked from a Jira ticket later, not the reverse |

Don't file both for the same request unless the user asks — pick one based on the
signal above.

**Usage:** `/dg:file "<summary>" [--body <text>] [--label <name>]... [--assignee <user>]... [--repo owner/repo] [--provider github|gitlab]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--body <text>` | none | Issue body. | empty |
| `--label <name>` | none | Add a label. Repeat for more labels. | none |
| `--assignee <user>` | none | Assign a user. Repeat for more users. | none |
| `--repo owner/repo` | none | Target repository. | current repo |
| `--provider github\|gitlab` | none | Target provider. | auto-detected |

## Subcommands

| Subcommand | Does |
|---|---|
| `~/.dg/bin/dg-skills file create --title <t> [--body <text>] [--label <name>]... [--assignee <user>]...` | Creates the issue; prints the normalized created issue as JSON |
| `~/.dg/bin/dg-skills file list [--state open\|closed\|all] [--label <name>] [--limit N] [--group-by-label]` | Lists issues as JSON; `--group-by-label` reshapes the array into `{label: Issue[]}` buckets (an issue with two labels appears in both) |
| `~/.dg/bin/dg-skills file view <number>` | Prints one normalized issue |
| `~/.dg/bin/dg-skills file bucket <label> <number> [<number>...] [--create]` | Attaches `<label>` to every given issue number, in one call — this is how work gets grouped. `--create` makes the label first (idempotent — never recolors an existing one) |

All subcommands accept `--repo owner/repo` (defaults to the current repo) and
`--provider github\|gitlab` (defaults to auto-detected).

## Filing an issue

1. Parse the summary and any flags from the invocation (natural language like
   `/dg:file "Login page 500s under load" --label bug` maps to `create --title "..." --label bug`).
2. Run `~/.dg/bin/dg-skills file create --title <summary> [flags]`, passing the title and body as single-quoted arguments (write an embedded `'` as `'\''`) so quotes, `$()` and backticks stay literal. If the underlying `gh`/`glab` call fails (not authenticated, label
   doesn't exist, etc.), report the error verbatim and what input would fix it — don't
   blindly retry.
3. Report back: issue number, URL, labels, assignees.

## Bucketing similar issues together

The CLI has no fuzzy-matching of its own — a shared **label** is the bucket, and
deciding which issues are similar enough to share one is a judgment call for you, not
the CLI:

1. Run `~/.dg/bin/dg-skills file list` (or `~/.dg/bin/dg-skills file list --group-by-label` to see existing buckets first).
2. Read the titles/bodies and decide which open issues describe the same underlying
   problem or belong to the same piece of work.
3. Pick a short, descriptive bucket label (e.g. `bucket:auth-flakiness`, not `misc`).
4. Run `~/.dg/bin/dg-skills file bucket <label> <n1> <n2> ...` — add `--create` the first time a bucket label is
   used so it exists on the provider (subsequent runs can omit `--create`, or leave it
   on since it's idempotent).
5. Report which issues got bucketed under which label, and why you judged them similar.

Bucketing is additive — it never removes an issue's existing labels, so an issue can
belong to more than one bucket.

## Error handling

Provider CLI failures (auth, missing label, rate limit) propagate as a non-zero exit
with the real `gh`/`glab` error text on stderr — surface that verbatim rather than
guessing at a cause.
