---
name: wayfinder
description: Chart a piece of work too big for one session as a map of decision tickets, then resolve them one per session until the way to the destination is clear. Planning only - it ends in a decision set that /dg:kick or /dg:grill-me takes over. Use for a loose, foggy, multi-session idea, or to resume a map. Adapted from mattpocock/skills.
---

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills stash --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.16.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor stash.

# /dg:wayfinder - Chart the Way, Then Walk It

A loose idea is too big for one session and wrapped in fog. Find the way to the **destination** before you build. A **map** lists the decisions made and the fog left. **Tickets** are single decisions, each sized for one session. Resolve one ticket per session until no ticket and no fog remain. Then hand off.

**Usage:** `/dg:wayfinder "<loose idea>"` (chart) · `/dg:wayfinder <map-slug> [ticket]` (work) · `/dg:wayfinder -l` (list maps)

Adapted from Matt Pocock's `wayfinder` (mattpocock/skills). The map lives in local markdown, not on an issue tracker.

## When to use /dg:wayfinder, not that

| Signal | Skill | Why |
|---|---|---|
| Big, foggy, needs many sessions of decisions | `/dg:wayfinder` | Decisions come first, across sessions |
| One feature, shape is clear | `/dg:kick` | Parks a build bundle without a map |
| One design, fits one session | `/dg:grill-me` | One interview, no map |
| Something is broken | `/dg:hunt` | Diagnosis, not design |
| Only a list of open questions in this chat | `/dg:walk` | No durable map needed |
| Decisions are done, you want to defer the build | `/dg:kick` | Parks a bundle |

Wayfinder ends where `/dg:kick` starts. Never build inside a map.

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `"<idea>"` | none | Chart mode. Create a new map. | none |
| `<map-slug> [ticket]` | none | Work mode. Resolve one ticket, or the next frontier ticket. | none |
| `--list` | `-l` | List maps with open-ticket and fog counts. Read only. | off |

## Routing

| Step | Where | Reference |
|---|---|---|
| Name destination, sketch fog, create tickets | Chart mode | [references/map.md](references/map.md) |
| Claim, resolve, record, graduate fog | Work mode | [references/work.md](references/work.md) |
| Map file and ticket file formats | Both | [references/map.md](references/map.md) |
| List maps (`-l`) | Here | For each directory under `$(~/.dg/bin/dg-skills stash -m wayfinder)/`, print the slug, the count of tickets with `status: open`, and the fog count. The fog count is the number of non-blank lines under `## Not yet specified` in `map.md`. |

## Where the map lives

`$(~/.dg/bin/dg-skills stash -m wayfinder)/<slug>/` holds `map.md` and `tickets/NNN-<slug>.md`. Get the path from `~/.dg/bin/dg-skills stash`. Never build it by hand. `-m` resolves to `<main worktree>/.agents/wayfinder`, inside the repo. Commit the map like a spec bundle, with `git add -f`, because `/dg:agent-seed` ignores `.agents/`. For a session handoff, append a `## Handoff` section to `map.md` with the next ticket title and what is still fog. Do not call a separate jot command.

## Rules

1. **Plan, don't do.** A ticket resolves a decision. The urge to start building marks the edge of the map. Hand off.
2. **One ticket per session.** Research tickets are the one exception.
3. **Refer by name.** Say the ticket title in all prose. Never a bare number.
4. **The map is an index.** A decision lives in its ticket. The map holds one gist line and a link.
5. **Fog or ticket?** Ticket it when you can state the question sharply, even if you cannot answer it. Otherwise keep it in the fog. Do not pre-slice fog.
6. **Out of scope is closed.** It never graduates and never counts as a decision.
7. **HITL tickets need the human.** The main loop asks with `AskUserQuestion`, one question per call, each with a recommendation. The agent never answers for the human.
8. **Subagents never ask.** They emit `⚑ RATIFY: <question> — <options> — <recommendation>`. The main loop relays it before building on it.
9. **Tiering and cost.** Pin research fan-out to `sonnet`. Before firing 3 or more research agents, show a rough token estimate (agents × sonnet, one session each) and confirm.
10. **Check first.** Read the code and docs before asking the human. Ask only what the human uniquely knows.

## Handoff when the map is clear

Every ticket closed, **Not yet specified** empty. Then offer:

| Next | When |
|---|---|
| `/dg:kick "<destination>"` | Destination is a feature or a change in place. Pass the map path as input context. |
| `/dg:grill-me` | One design question is still open. Finish it before kicking. |
