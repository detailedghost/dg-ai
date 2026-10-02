# Overwatch board — Initial Notes

## Purpose
A live board in the dg extension that shows every parallel Claude Code chat as a lane with its stage (review, CI, E2E, merge), MR, ETA and a next-you flag, plus a go-live countdown, background agents and today's merges. Chats or an overwatch chat push status through dg-agent to dg-daemon, which pushes the full board to the extension. One Actions button per lane sends reply, approve or reject back to the lane publisher through agent mail. A read-only snapshot renders to a claude.ai artifact for phone use.

## Scope
### Included
- Lane per chat keyed by chat name: task, stage cells, MR, ETA, next-you flag, open-chat link, updated-ago
- Top bar countdown to go-live and N need you pill; footer background agents and today's merges
- Everything live: lanes appear, update and disappear without reload
- One Actions button per lane with Reply, Approve, Reject (reject needs a note), routed to the lane publisher via agent_messages
- dg-agent overwatch set, remove, merged, launch, open, snapshot
- /stat --overwatch opens or focuses the board; phone read-only artifact republished on change, max 1 per 2 min
- Design reproduces prototype .agents/prototype/overwatch-v2/manifest.md variant E
### Excluded
- Phone interactivity
- Non-loopback daemon access
- Polling GitLab for CI or MR state
- Lane auto-expiry
- Playwright E2E suite (manual E2E checklist instead)
