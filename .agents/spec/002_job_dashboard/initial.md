# Scheduled jobs and job dashboard — Initial Notes

## Purpose
The daemon runs a command only when a human clicks one in a chat session, so recurring checks of Jira, Datadog and Sentry stay manual and their answers die with the session. This feature gives the daemon a clock, a place to keep job definitions, and a feed of what each run brought back. A new dashboard page shows the feed, and any item can be handed to a named agent identity to act on.

## Scope
### Included
- Schema v7: scheduled_jobs and feed_items, encrypted under a reserved scheduler session id
- A tick timer that runs due jobs through the existing command executor and its limits
- Dedupe of feed items on a stable per-item id, so a re-run reports only what is new
- The daemon idle test counts enabled jobs, so a job outlives the last chat session
- Loopback HTTP routes for jobs and feed, guarded like POST /start
- dg-daemon job add|list|rm|enable|disable|run
- The dashboard extension page, built to approved prototype variant A
- Queue a feed item to an agent identity: automatic per job opt-in, plus a manual button
### Excluded
- The cron config page for adding and editing jobs in the browser
- Jira, Datadog and Sentry client code inside the daemon: a job is an argv that prints JSON lines
- Credential storage: a job authenticates through its own tool config below HOME
- WebSocket push for job and feed data: the page polls
- An OS-level service unit; the idle test keeps the daemon alive instead
