---
feature: Scheduled jobs and job dashboard
feature_snake_case: job_dashboard
date: '2026-09-03'
version: '1.0'
status: complete
current_slice: 5
pr_strategy: single
slices:
  - id: 1
    name: job-store
    depends_on: []
    files:
      - pkg/dg-daemon/src/store/**
      - pkg/dg-daemon/__tests__/store/**
    agents:
      primary: dba
      qa:
        - qa-code
        - security
  - id: 2
    name: job-runner
    depends_on:
      - 1
    files:
      - pkg/dg-daemon/src/jobs/**
      - pkg/dg-daemon/src/server/bootstrap.ts
      - pkg/dg-daemon/__tests__/jobs/**
    agents:
      primary: js
      qa:
        - qa-code
  - id: 3
    name: job-http
    depends_on:
      - 1
      - 2
    files:
      - pkg/dg-daemon/src/server/http.ts
      - pkg/common/src/chat-format.ts
      - pkg/dg-daemon/__tests__/server/jobs-http.spec.ts
      - pkg/common/__tests__/chat-format.spec.ts
    agents:
      primary: js
      effort: xhigh
      qa:
        - security
        - qa-code
  - id: 4
    name: job-cli
    depends_on:
      - 1
      - 2
    files:
      - pkg/dg-daemon/src/index.ts
      - pkg/dg-daemon/src/commands/**
      - pkg/dg-daemon/__tests__/commands/**
    agents:
      primary: js
      qa:
        - qa-code
  - id: 5
    name: dashboard-page
    depends_on:
      - 3
    files:
      - pkg/extension/entrypoints/dashboard/**
      - pkg/extension/lib/features/dashboard.ts
      - pkg/extension/wxt.config.ts
      - pkg/extension/__tests__/dashboard.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
worktree:
  path: /home/detailedghost/code/worktrees/dg-job_dashboard
  origin_repo: /home/detailedghost/code/dg
  branch: feature/job_dashboard
  pr_url: https://github.com/detailedghost/dg-ai/pull/2
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
- [x] Add schema step v7 to SCHEMA_STEPS: scheduled_jobs (id, label unique, argv ciphertext, cwd, interval_ms, enabled, notify_identity, last_run_at, next_run_at, last_exit_code, last_error ciphertext) and feed_items (id, job_id references scheduled_jobs, fingerprint, created_at, title/meta/url ciphertext, read_at)
- [x] Unique index on feed_items(job_id, fingerprint); partial index on unread items per job
- [x] Export SCHEDULER_SESSION_ID and call the existing private ensureSessionRow for it when the store opens
- [x] Add store methods: listJobs, getJob, getJobByLabel, insertJob, setJobEnabled, deleteJob, countEnabledJobs, recordJobRun, dueJobs
- [x] Add feed methods: insertFeedItems, listFeedItems, markFeedItemRead, markAllRead, countUnreadByJob
- [x] Encrypt argv, last_error and every feed item field with the existing AAD helper, scoped to the reserved session id

#### Testing Criteria
##### Contracts
- [x] Contract: insertFeedItems is idempotent on (job_id, fingerprint) and reports inserted and duplicate counts
- [x] Contract: recordJobRun sets last_run_at, next_run_at = last_run_at + interval_ms, and last_exit_code; a failure also stores last_error
- [x] Contract: dueJobs returns only enabled jobs whose next_run_at is at or before the supplied time
- [x] Contract: countEnabledJobs counts enabled rows only
- [x] Every ciphertext column round-trips through the reserved session id AAD
- [x] A v6 database migrates to v7 with every pre-existing message, asset and agent message still decrypting
- [x] Deleting a job removes its feed items and leaves other jobs untouched

#### Acceptance Criteria
- [x] Given a v6 database, when the daemon opens it, then it reports user_version 7 and all pre-existing rows still decrypt
- [x] Given the same item id inserted on two runs, when the feed is listed, then exactly one row exists

### Slice 2 — job-runner

#### Engineering
- [x] Add jobs/parse.ts: stdout to items, one JSON object per line, id and title required, meta and url optional, fingerprint is the item id
- [x] A malformed line fails the whole run with a parse error and inserts nothing from that run
- [x] Add jobs/runner.ts: a 30s tick that reads dueJobs and runs each through executeCommand with resolveLimits, admitted by DispatchScheduler.tryAdmit under the reserved session id
- [x] Record every run with recordJobRun, including exit code and the stderr tail on failure
- [x] When a job carries notify_identity and the run produced new items, queue one agent message per run through insertAgentMessage from the reserved session id
- [x] Wire the tick in bootstrap.ts beside the existing reap timer, unref it, and clear it in shutdown
- [x] Extend the idle predicate so the daemon stays alive while any job is enabled

#### Testing Criteria
##### Contracts
- [x] Contract: parse accepts one JSON object per line and returns items keyed by id; a line missing id or title is a parse error
- [x] Contract: a run exiting 0 with two new lines yields two feed items and one recorded run
- [x] Contract: re-running the same command yields zero new items and still advances last_run_at and next_run_at
- [x] Contract: a non-zero exit records the failure and the stderr tail and inserts no items
- [x] Contract: a malformed line records a parse failure and inserts no items from that run
- [x] A disabled job is never picked up, and a job past next_run_at always is
- [x] A job with notify_identity queues exactly one agent message when new items land, and none when nothing is new
- [x] The idle controller does not fire while an enabled job exists, and does fire once the last job is disabled

#### Acceptance Criteria
- [x] Given one enabled job and no chat sessions, when the idle TTL elapses, then the daemon is still running and the job has run at least once
- [x] Given a job that fails, when the feed is read, then the failure and its message are visible and no items were invented

### Slice 3 — job-http

#### Engineering
- [x] Add path constants beside the existing CHAT_*_PATH exports in chat-format.ts
- [x] GET /jobs returns every job with status, interval, last run, next run, last exit and unread count
- [x] GET /feed returns items newest first, filtered by jobId and unread, bounded by limit
- [x] POST /jobs/:id/run runs the job now; POST /feed/:id/read; POST /feed/read-all; POST /feed/:id/queue with body { identity }
- [x] Guard every route the way POST /start is guarded: loopback host, extension origin, pinned origin
- [x] Unknown job or item returns 404; a refused origin or host returns 401

#### Testing Criteria
##### Contracts
- [x] Contract: the GET /jobs payload shape, field by field, including the failed and paused states
- [x] Contract: the GET /feed payload shape, and that unread and jobId filters compose
- [x] Contract: POST /feed/:id/queue inserts exactly one agent message addressed to the given identity
- [x] Contract: POST /jobs/:id/run runs the job and moves next_run_at forward
- [x] A non-loopback Host is refused 401 and an unpinned origin is refused 401
- [x] An unknown job id and an unknown feed item id both return 404
- [x] POST /feed/read-all marks every item read and returns the count

#### Acceptance Criteria
- [x] Given a seeded job with items, when each route is called over loopback with the pinned extension origin, then it returns the documented shape and status

### Slice 4 — job-cli

#### Engineering
- [x] Add a job command group to the existing commander program: add, list, rm, enable, disable, run
- [x] dg-daemon job add --label <l> --every <15m> --cwd <path> [--notify <identity>] -- <argv...>
- [x] Parse --every as a duration of the form 30s, 15m or 2h
- [x] list prints label, interval, enabled, last run, next run, last exit and unread count
- [x] Reuse checkExecutable so a job whose command is not on PATH is refused at add time

#### Testing Criteria
##### Contracts
- [x] Contract: --every accepts 30s, 15m and 2h and rejects anything else with a non-zero exit
- [x] Contract: add with a duplicate label fails and writes nothing
- [x] Contract: add refuses an argv whose first element is not on PATH
- [x] rm removes the job and its feed items; enable and disable flip only the enabled flag
- [x] list on an empty store prints an explicit empty line rather than nothing

#### Acceptance Criteria
- [x] Given a running daemon, when a job is added by CLI and list is run, then the job appears with its next run in the future

### Slice 5 — dashboard-page

#### Engineering
- [x] Add an entrypoint beside chat, options and review: index.html, main.ts, style.css, importing ../options/style.css first so the shared tokens resolve
- [x] Build approved prototype variant A exactly: two columns, the two-line job row, the summary strip, the sweep line toward the next run, the failure banner above the feed, unread dot and weight, the queue button on hover
- [x] Set data-theme dark as the initial value
- [x] Put fetch and render logic in lib/features/dashboard.ts so it is testable without the DOM entrypoint
- [x] Poll every 10s; stop on visibilitychange to hidden and resume on visible
- [x] Render an explicit offline state when the daemon does not answer, keeping the last good data on screen
- [x] Render the + Schedule control inert, marked as the next page

#### Testing Criteria
##### Contracts
- [x] Contract: the client maps GET /jobs and GET /feed payloads onto the render model, including failed and paused jobs
- [x] Contract: unread counts come from the payload and are never recounted in the page
- [x] Contract: a fetch rejection renders the offline state and does not clear the last good data
- [x] Contract: the poll timer stops when the document hides and resumes when it shows
- [x] Selecting a job filters the feed to that job
- [x] Queue to agent posts once per click and reports the outcome

#### Acceptance Criteria
- [x] Given a daemon with one healthy job, one failed job and one paused job, when the dashboard opens, then all three states render as the approved prototype draws them
- [x] Given the daemon is not running, when the dashboard opens, then it says so plainly instead of showing an empty feed

## Slice Summaries

### Slice 1 — job-store (`9508dd1`)
Schema step v7 adds `scheduled_jobs` and `feed_items` as STRICT tables. Argv, the
daemon's failure reason, the command's stderr, and every feed item field are
encrypted under the reserved `__scheduler__` session id, so the AAD binds each
value to its own row. Dedupe is a unique index on `(job_id, fingerprint)`, where
the fingerprint is the item id the job printed.

`feed_items.seq` is an `INTEGER PRIMARY KEY AUTOINCREMENT`, which makes it the
rowid, so newest-first paging never sorts.

### Slice 2 — job-runner (`4d12c72`)
`jobs/parse.ts` reads stdout as one JSON object per line and names the offending
line number on a parse error. `jobs/runner.ts` ticks every 30s, reads `dueJobs`,
and runs each through the existing `executeCommand` with `resolveLimits`, admitted
by the daemon's `DispatchScheduler` under the reserved session id.

A failed run still advances `next_run_at`, so one bad job cannot spin. The idle
predicate moved into `jobs/idle.ts` so it could be tested on its own.

### Slice 3 — job-http (`df51e09`)
Six routes behind one `requireExtensionOrigin` gate, shared with `handleWsUpgrade`.

**Deviation from the plan text:** the plan says a refused origin answers 401. It
answers **400**, which is what `/ws` and `/start` already answer for the same
refusal. The code matches the daemon's existing posture; the plan text is stale.
Recorded as R13 below.

`GET /jobs` withholds both `argv` and `cwd`. The page needs neither, and both name
things on the user's disk.

### Slice 4 — job-cli (`c158e84`)
`job add|list|rm|enable|disable|run` on the existing commander program. `--every`
accepts `30s`, `15m`, `2h` and nothing else. `add` runs the argv's first element
through `checkExecutable`, so a typo is refused at add time rather than at the
first tick.

`list` prints the daemon's reason and the command's stderr on separate lines. Only
the reason crosses to the browser.

### Slice 5 — dashboard-page (`9a169d7`)
The entrypoint follows `chat/`: `index.html`, `main.ts`, `style.css`, importing
`../options/style.css` first so the shared tokens resolve. Built to prototype
variant A. `lib/features/dashboard.ts` holds every pure function, so the render
model, the poller and the API client are all tested without a DOM.

`data-theme="dark"` is the initial value on the root element.

## Agent Notes

**`db.transaction()` is unusable in bun 1.2.22.** Every call leaves a statement
unfinalized, so `db.close(true)` throws "database is locked" and any test that
opens a store twice fails. Proved with a probe script across every existing use.
The house idiom is explicit:

```ts
this.db.run("BEGIN IMMEDIATE");
try {
  // ...
  this.db.run("COMMIT");
} catch (err) {
  try { this.db.run("ROLLBACK"); } catch {}
  throw err;
}
```

`UPDATE ... RETURNING` through `db.query(...).get(...)` has the same defect.

**Scheduler rows need a reserved session id.** `agent_messages.sender_session_id`
is `NOT NULL REFERENCES sessions(id)`, and `ChatStore.#aad` keys the AAD by
session id. A daemon-owned job has no session, so one reserved id supplies both.
`ensureSessionRow` is idempotent, and the in-memory `SessionRegistry` never sees
the row, so neither the idle test nor `sessionCount` is affected.

**Two pre-existing test failures, both confirmed unrelated.**
`pkg/extension/__tests__/demo-tour-review.spec.ts` fails at the merge base and
with this branch's files reverted. `pkg/dg-daemon/__tests__/session/session-ttl.spec.ts`
is a timing flake that passes on a clean run and fails identically on the base
commit.

## Slice Summaries

## Agent Notes

## Issues Remediation
### Final review, round 1 — triage

Four reviewers ran against merge-base `f7ea697`. Accepted findings, grouped by what they fix.

**Correctness**

| id | Where | Finding | Action |
|---|---|---|---|
| R1 | `server/bootstrap.ts`, `server/http.ts` | Two `DispatchScheduler` instances, so `DISPATCH_MAX_CONCURRENT_DAEMON_WIDE` is not daemon-wide. The tick can run a job while the dashboard's "run now" runs the same one. | Own one in `bootstrap.ts`, pass it to both. |
| R5 | `jobs/runner.ts` | The notify body diffs against `listFeedItems`, which is capped at 200. Past that, a duplicate is reported as new. | Have `insertFeedItems` return what it actually inserted. |
| R6 | `store/index.ts`, `server/http.ts` | `markFeedItemRead` cannot tell "unknown id" from "already read", so a repeat click answers 404. | Make it idempotent. |
| S1 | `jobs/runner.ts`, `server/http.ts` | Raw stderr reaches the browser as `lastError`, while `argv` is withheld from the same route for the same reason. | Keep the daemon's own reason on the wire, keep stderr on the CLI. |
| S2 | `server/http.ts` | `GET /jobs` returns `cwd`, which the page never renders. | Drop it. |

**Performance** (measured with `EXPLAIN QUERY PLAN`, not inferred)

| id | Where | Finding | Action |
|---|---|---|---|
| P1 | `store/schema.ts` | `listFeedItems({jobId})` has no usable index and sorts every row for that job in a temp B-tree. The tick runs this query per due job, and `feed_items` has no prune path. | Add `(job_id, seq)`. |
| P4 | `store/schema.ts` | `idx_feed_items_recent ON (seq)` is dead — `seq` is the rowid. Costs a B-tree write per insert. | Remove from the v7 DDL, which has not shipped. |
| P3 | `store/index.ts` | One `BEGIN IMMEDIATE` around an unbounded batch holds the write lock; 256KB of output is thousands of items. | Chunk the batch. |
| P2 | `jobs/runner.ts` | Jobs run strictly sequentially, so one hung job stalls all evaluation for N x 30s. | Run concurrently, bounded by the shared scheduler from R1. |
| P8 | `entrypoints/dashboard/main.ts` | Any failed poll drops the API handle, so the next tick probes 10 ports with 2s timeouts, every tick. | Retry the known port first. |
| P6 | `entrypoints/dashboard/main.ts` | The 10s poll calls `replaceChildren` unconditionally, destroying a half-typed agent identity. | Skip the re-render when nothing changed and an editor is open. |
| P7 | `entrypoints/dashboard/main.ts` | `jobs.find()` inside the item loop. | Build a Map once per render. |

**Duplication and convention**

| id | Where | Finding | Action |
|---|---|---|---|
| R2 | `lib/features/dashboard.ts` vs `commands/jobs.ts` | "What counts as failed" is written twice and can drift. | Hoist to `@dg/common`. |
| R3 | same pair | Interval formatting written twice. | Hoist to `@dg/common`. |
| R4 | `server/http.ts` | `requireExtensionOrigin` duplicates the gate inlined in `handleWsUpgrade`. | Call the helper from both. |
| R7 | 4 files | Doc comments run 2-3 sentences against this project's one-line rule. | Trim; rationale is already in the commit messages. |

**Test gaps**

| id | Gap | Action |
|---|---|---|
| P5 | `query-plans.spec.ts` covers every older hot path but no v7 query. It would have caught P1. | Add cases for `dueJobs`, both `listFeedItems` shapes, `countUnreadByJob`. |
| R8 | The v6 to v7 test proves tables exist but never decrypts a pre-existing message, asset or agent message — which is what the acceptance criterion actually says. | Seed and decrypt all three. |
| R10 | Every origin test hits the "not an extension scheme" branch. `checkPinnedOrigin` passes when nothing is pinned, so the mismatch branch is untested. | Pin one origin, then hit a route with another. |
| R9 | No test for the poll stopping on `visibilitychange`. | Cover it. |
| R11 | `runner.spec.ts` has a dead variable and `expect(scheduler).toBeDefined()`, an assertion that cannot fail. | Delete both lines. |
| R12 | `insertJob` defaults `nextRunAt` to now, so a new job is immediately due, and nothing asserts it either way. | Confirm the intent and assert it. |

**Recorded, not fixed**

- R13 — the plan text says these routes answer 401; they answer 400, matching `/ws` and `/start`. The plan text is stale; the code and its tests agree. Already noted in the slice 3 summary.
- `feed_items` has no retention or prune path, unlike `agent_messages` and assets. It grows for the life of the daemon. P1's index makes that survivable, but a prune belongs in a follow-up — it is new scope, not a defect in this branch.

### Final review, round 1 — outcome

Every accepted finding above is fixed and committed:

| Commit | Covers |
|---|---|
| `da966a2` `refactor(common)` | R2, R3 |
| `33cc743` `fix(dg-daemon)` | R1, R5, R6, R7, R8, R10, R11, R12, S1, S2, P1, P2, P3, P4, P5 |
| `aba3952` `fix(extension)` | R9, P6, P7, P8 |

Verification after the round: `pkg/dg-daemon` 417 pass / 0 fail, `pkg/common`
116 pass, `pkg/extension` 633 pass / 1 pre-existing fail. Lint and build clean in
all three. `query-plans.spec.ts` now asserts the v7 hot paths seek an index and
run no temp b-tree sort.

One round was enough. No finding needed escalation.

### Docs pass

`README.md` gains the scheduled-jobs block beside the other daemon features.
`docs/DEVELOPER.md` gains a paragraph on `src/jobs/` and the reserved session id.
Jira, Datadog, Sentry and "dedupes" go into the vale vocabulary. Committed as
`e170258`.

### Pull request

Draft PR: https://github.com/detailedghost/dg-ai/pull/2

Opened as a draft because no human has read the code yet. The human review
happens there.
