---
feature: "Scheduled jobs and job dashboard"
feature_snake_case: job_dashboard
date: "2026-09-03"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "job-store"
    depends_on: []
    files: ["pkg/dg-daemon/src/store/**","pkg/dg-daemon/__tests__/store/**"]
    agents:
      primary: dba
      qa: [qa-code, security]
  - id: 2
    name: "job-runner"
    depends_on: [1]
    files: ["pkg/dg-daemon/src/jobs/**","pkg/dg-daemon/src/server/bootstrap.ts","pkg/dg-daemon/__tests__/jobs/**"]
    agents:
      primary: js
      qa: [qa-code]
  - id: 3
    name: "job-http"
    depends_on: [1,2]
    files: ["pkg/dg-daemon/src/server/http.ts","pkg/common/src/chat-format.ts","pkg/dg-daemon/__tests__/server/jobs-http.spec.ts","pkg/common/__tests__/chat-format.spec.ts"]
    agents:
      primary: js
      effort: xhigh
      qa: [security, qa-code]
  - id: 4
    name: "job-cli"
    depends_on: [1,2]
    files: ["pkg/dg-daemon/src/index.ts","pkg/dg-daemon/src/commands/**","pkg/dg-daemon/__tests__/commands/**"]
    agents:
      primary: js
      qa: [qa-code]
  - id: 5
    name: "dashboard-page"
    depends_on: [3]
    files: ["pkg/extension/entrypoints/dashboard/**","pkg/extension/lib/features/dashboard.ts","pkg/extension/wxt.config.ts","pkg/extension/__tests__/dashboard.spec.ts"]
    agents:
      primary: js
      qa: [qa-code]
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
---

# Scheduled jobs and job dashboard

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

### Slice 1 — job-store

#### Engineering
- [ ] Add schema step v7 to SCHEMA_STEPS: scheduled_jobs (id, label unique, argv ciphertext, cwd, interval_ms, enabled, notify_identity, last_run_at, next_run_at, last_exit_code, last_error ciphertext) and feed_items (id, job_id references scheduled_jobs, fingerprint, created_at, title/meta/url ciphertext, read_at)
- [ ] Unique index on feed_items(job_id, fingerprint); partial index on unread items per job
- [ ] Export SCHEDULER_SESSION_ID and call the existing private ensureSessionRow for it when the store opens
- [ ] Add store methods: listJobs, getJob, getJobByLabel, insertJob, setJobEnabled, deleteJob, countEnabledJobs, recordJobRun, dueJobs
- [ ] Add feed methods: insertFeedItems, listFeedItems, markFeedItemRead, markAllRead, countUnreadByJob
- [ ] Encrypt argv, last_error and every feed item field with the existing AAD helper, scoped to the reserved session id

#### Testing Criteria
##### Contracts
- [ ] Contract: insertFeedItems is idempotent on (job_id, fingerprint) and reports inserted and duplicate counts
- [ ] Contract: recordJobRun sets last_run_at, next_run_at = last_run_at + interval_ms, and last_exit_code; a failure also stores last_error
- [ ] Contract: dueJobs returns only enabled jobs whose next_run_at is at or before the supplied time
- [ ] Contract: countEnabledJobs counts enabled rows only
- [ ] Every ciphertext column round-trips through the reserved session id AAD
- [ ] A v6 database migrates to v7 with every pre-existing message, asset and agent message still decrypting
- [ ] Deleting a job removes its feed items and leaves other jobs untouched

#### Acceptance Criteria
- [ ] Given a v6 database, when the daemon opens it, then it reports user_version 7 and all pre-existing rows still decrypt
- [ ] Given the same item id inserted on two runs, when the feed is listed, then exactly one row exists

### Slice 2 — job-runner

#### Engineering
- [ ] Add jobs/parse.ts: stdout to items, one JSON object per line, id and title required, meta and url optional, fingerprint is the item id
- [ ] A malformed line fails the whole run with a parse error and inserts nothing from that run
- [ ] Add jobs/runner.ts: a 30s tick that reads dueJobs and runs each through executeCommand with resolveLimits, admitted by DispatchScheduler.tryAdmit under the reserved session id
- [ ] Record every run with recordJobRun, including exit code and the stderr tail on failure
- [ ] When a job carries notify_identity and the run produced new items, queue one agent message per run through insertAgentMessage from the reserved session id
- [ ] Wire the tick in bootstrap.ts beside the existing reap timer, unref it, and clear it in shutdown
- [ ] Extend the idle predicate so the daemon stays alive while any job is enabled

#### Testing Criteria
##### Contracts
- [ ] Contract: parse accepts one JSON object per line and returns items keyed by id; a line missing id or title is a parse error
- [ ] Contract: a run exiting 0 with two new lines yields two feed items and one recorded run
- [ ] Contract: re-running the same command yields zero new items and still advances last_run_at and next_run_at
- [ ] Contract: a non-zero exit records the failure and the stderr tail and inserts no items
- [ ] Contract: a malformed line records a parse failure and inserts no items from that run
- [ ] A disabled job is never picked up, and a job past next_run_at always is
- [ ] A job with notify_identity queues exactly one agent message when new items land, and none when nothing is new
- [ ] The idle controller does not fire while an enabled job exists, and does fire once the last job is disabled

#### Acceptance Criteria
- [ ] Given one enabled job and no chat sessions, when the idle TTL elapses, then the daemon is still running and the job has run at least once
- [ ] Given a job that fails, when the feed is read, then the failure and its message are visible and no items were invented

### Slice 3 — job-http

#### Engineering
- [ ] Add path constants beside the existing CHAT_*_PATH exports in chat-format.ts
- [ ] GET /jobs returns every job with status, interval, last run, next run, last exit and unread count
- [ ] GET /feed returns items newest first, filtered by jobId and unread, bounded by limit
- [ ] POST /jobs/:id/run runs the job now; POST /feed/:id/read; POST /feed/read-all; POST /feed/:id/queue with body { identity }
- [ ] Guard every route the way POST /start is guarded: loopback host, extension origin, pinned origin
- [ ] Unknown job or item returns 404; a refused origin or host returns 401

#### Testing Criteria
##### Contracts
- [ ] Contract: the GET /jobs payload shape, field by field, including the failed and paused states
- [ ] Contract: the GET /feed payload shape, and that unread and jobId filters compose
- [ ] Contract: POST /feed/:id/queue inserts exactly one agent message addressed to the given identity
- [ ] Contract: POST /jobs/:id/run runs the job and moves next_run_at forward
- [ ] A non-loopback Host is refused 401 and an unpinned origin is refused 401
- [ ] An unknown job id and an unknown feed item id both return 404
- [ ] POST /feed/read-all marks every item read and returns the count

#### Acceptance Criteria
- [ ] Given a seeded job with items, when each route is called over loopback with the pinned extension origin, then it returns the documented shape and status

### Slice 4 — job-cli

#### Engineering
- [ ] Add a job command group to the existing commander program: add, list, rm, enable, disable, run
- [ ] dg-daemon job add --label <l> --every <15m> --cwd <path> [--notify <identity>] -- <argv...>
- [ ] Parse --every as a duration of the form 30s, 15m or 2h
- [ ] list prints label, interval, enabled, last run, next run, last exit and unread count
- [ ] Reuse checkExecutable so a job whose command is not on PATH is refused at add time

#### Testing Criteria
##### Contracts
- [ ] Contract: --every accepts 30s, 15m and 2h and rejects anything else with a non-zero exit
- [ ] Contract: add with a duplicate label fails and writes nothing
- [ ] Contract: add refuses an argv whose first element is not on PATH
- [ ] rm removes the job and its feed items; enable and disable flip only the enabled flag
- [ ] list on an empty store prints an explicit empty line rather than nothing

#### Acceptance Criteria
- [ ] Given a running daemon, when a job is added by CLI and list is run, then the job appears with its next run in the future

### Slice 5 — dashboard-page

#### Engineering
- [ ] Add an entrypoint beside chat, options and review: index.html, main.ts, style.css, importing ../options/style.css first so the shared tokens resolve
- [ ] Build approved prototype variant A exactly: two columns, the two-line job row, the summary strip, the sweep line toward the next run, the failure banner above the feed, unread dot and weight, the queue button on hover
- [ ] Set data-theme dark as the initial value
- [ ] Put fetch and render logic in lib/features/dashboard.ts so it is testable without the DOM entrypoint
- [ ] Poll every 10s; stop on visibilitychange to hidden and resume on visible
- [ ] Render an explicit offline state when the daemon does not answer, keeping the last good data on screen
- [ ] Render the + Schedule control inert, marked as the next page

#### Testing Criteria
##### Contracts
- [ ] Contract: the client maps GET /jobs and GET /feed payloads onto the render model, including failed and paused jobs
- [ ] Contract: unread counts come from the payload and are never recounted in the page
- [ ] Contract: a fetch rejection renders the offline state and does not clear the last good data
- [ ] Contract: the poll timer stops when the document hides and resumes when it shows
- [ ] Selecting a job filters the feed to that job
- [ ] Queue to agent posts once per click and reports the outcome

#### Acceptance Criteria
- [ ] Given a daemon with one healthy job, one failed job and one paused job, when the dashboard opens, then all three states render as the approved prototype draws them
- [ ] Given the daemon is not running, when the dashboard opens, then it says so plainly instead of showing an empty feed

## Slice Summaries

## Agent Notes

## Issues Remediation
