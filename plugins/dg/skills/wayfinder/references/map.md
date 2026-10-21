# Map and ticket formats, chart mode

## Chart mode steps

1. **Name the destination.** Run a `/dg:grill-me` pass in the main loop. Pin down what the map reaches: a spec, a decision to lock, or a change made in place. Scope is fixed here.
2. **Map the frontier.** Grill again, breadth first. Surface open decisions and first takeable steps. Self-serve from the code and docs. If no fog appears and one session can hold it, write no map. Ask the user to choose `/dg:kick` or `/dg:grill-me`.
3. **Create the map.** `~/.dg/bin/dg-skills stash -m wayfinder <slug>/map.md`. Fill Destination and Notes. Leave Decisions empty. Sketch fog.
4. **Create sharp tickets** in `tickets/`. Number them `NNN-<slug>.md`. Set `blocked_by` in a second pass, after all files exist.
5. **Research tickets.** Show the cost estimate when there are 3 or more. Then run one `sonnet` subagent per `research` ticket (see work.md). Each subagent returns facts and writes no file. The main loop records each result under `## Resolution`, closes the ticket, and updates **Decisions so far**.
6. **Stop.** Charting is one session. It resolves no ticket except research.

## map.md

```markdown
# <map title>

## Destination
<spec, decision or change this map reaches. One or two lines.>

## Notes
<domain, skills each session should read, standing preferences>

## Decisions so far
- [<ticket title>](tickets/NNN-slug.md): <one-line gist>

## Not yet specified
<in-scope fog that cannot be ticketed yet>

## Out of scope
- [<ticket title>](tickets/NNN-slug.md): <gist and why it is out>
```

Open tickets are not listed in the map. Find them by their frontmatter.

## Ticket file

```markdown
---
type: research | prototype | grilling | task
status: open | closed
blocked_by: [NNN, NNN]
claimed: <session id and ISO timestamp, or empty>
---
# <ticket title>

## Question
<the decision or investigation. One session of work.>

## Resolution
<empty until closed. Answer, plus links to assets.>
```

## Ticket types

| Type | Who | Resolved by |
|---|---|---|
| research | AFK | `sonnet` subagent reads docs, APIs, local sources. Returns facts. |
| prototype | HITL | Build a tiny throwaway in the chat (a snippet, a short HTML file, or a CLI sketch). Ask the human to react. Link the asset. |
| grilling | HITL | `/dg:grill-me` in the main loop. The default type. |
| task | either | Manual step that unblocks a decision. Records facts later tickets need. |

## Frontier query

Frontier = `status: open`, every `blocked_by` ticket is `closed`, and `claimed` is empty or older than 24 hours. Read only the frontmatter with `rg -n -m3 '^(status|claimed|blocked_by):' <map dir>/tickets`. The `-m3` stops each file after its three frontmatter keys, so a `## Resolution` line cannot match.
