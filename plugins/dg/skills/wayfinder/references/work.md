# Work mode

Resolve one ticket per session. Research tickets are the exception.

1. **Load the map.** Read `map.md` only. Do not read every ticket.
2. **Choose.** Use the ticket the user named. Else take the first frontier ticket. Claim it: set `claimed` in its frontmatter first, before any work.
3. **Resolve by type.** Read `type` from the frontmatter.
   - grilling: `/grill-me` in the main loop on the ticket's question.
   - prototype: `/prototype`. Link the output. Ask the human to react.
   - research: one `sonnet` subagent. Brief it with the question, the why, and what done looks like. It returns facts. It writes no decisions. Any choice for the human comes back as `⚑ RATIFY`.
   - task: do it when AFK. Else give the human a precise checklist.
   Zoom into related closed tickets as needed. Read the skills the map's Notes name.
4. **Record.** Write the answer under `## Resolution`. Set `status: closed`. Clear `claimed`. Append one gist line and link to **Decisions so far**.
5. **Update the map.** Add new tickets, then wire `blocked_by`. Graduate fog that is now sharp. Delete each graduated patch from **Not yet specified**. Move a ticket past the destination to **Out of scope** and close it. Edit or remove tickets the answer invalidated.
6. **Check for done.** No open tickets and no fog: offer the handoff in SKILL.md. Otherwise save a session handoff with `/jot -s` if the user will resume later.

Other sessions may edit the same map. Re-read a ticket's frontmatter right before claiming it.
