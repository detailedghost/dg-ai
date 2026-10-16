---
name: wayfinder
description: Chart a piece of work too big for one session as a map of decision tickets, then resolve them one per session until the way to the destination is clear. Planning only - it ends in a decision set that /spec or /kick takes over. Use for a loose, foggy, multi-session idea, or to resume a map. Adapted from mattpocock/skills.
---

# /wayfinder — Chart the Way, Then Walk It

A loose idea is too big for one session and wrapped in fog. Find the way to the **destination** before you build. A **map** lists the decisions made and the fog left. **Tickets** are single decisions, each sized for one session. Resolve one ticket per session until no ticket and no fog remain. Then hand off.

**Usage:** `/wayfinder "<loose idea>"` (chart) · `/wayfinder <map-slug> [ticket]` (work) · `/wayfinder -l` (list maps)

Adapted from Matt Pocock's `wayfinder` (mattpocock/skills). The map lives in local markdown, not on an issue tracker.

## When to use /wayfinder, not that

| Signal | Skill | Why |
|---|---|---|
| Big, foggy, needs many sessions of decisions | `/wayfinder` | Decisions come first, across sessions |
| One feature, shape is clear | `/spec` | Goes straight to a build bundle |
| One design, fits one session | `/grill-me` | One interview, no map |
| Something is broken | `/hunt` | Diagnosis, not design |
| Only a list of open questions in this chat | `/walk` | No durable map needed |
| Decisions are done, you want to defer the build | `/kick` | Parks a bundle |

Wayfinder ends where `/spec` starts. Never build inside a map.

## Flags

| Flag | Effect |
|---|---|
| `"<idea>"` | Chart mode. Create a new map. |
| `<map-slug> [ticket]` | Work mode. Resolve one ticket, or the next frontier ticket. |
| `-l`, `--list` | List maps with open-ticket and fog counts. Read only. |

## Routing

| Step | Where | Reference |
|---|---|---|
| Name destination, sketch fog, create tickets | Chart mode | [references/map.md](references/map.md) |
| Claim, resolve, record, graduate fog | Work mode | [references/work.md](references/work.md) |
| Map file and ticket file formats | Both | [references/map.md](references/map.md) |

## Where the map lives

`$(stash -m wayfinder)/<slug>/` holds `map.md` and `tickets/NNN-<slug>.md`. Get the path from `stash`. Never build it by hand. Commit the map with the repo like a spec bundle. Use `/jot -s` for a session handoff.

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
| `/spec "<destination>"` | Destination is a feature. Pass the map path as input context. |
| `/kick` | Plan now, build later. |
| `/assign` | Destination is a change in place. Pick the agent. |
