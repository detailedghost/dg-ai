---
feature: "Overwatch board"
feature_snake_case: overwatch_board
date: "2026-10-02"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "overwatch-wire-types"
    depends_on: []
    files: ["pkg/common/src/chat-format.ts","pkg/common/src/cli-wire.ts","pkg/common/__tests__/*overwatch*"]
    agents:
      primary: js
      qa: [qa-code]
      proxy: codex
  - id: 2
    name: "daemon-board-store-and-routes"
    depends_on: [1]
    files: ["pkg/dg-daemon/src/store/*","pkg/dg-daemon/src/dispatch/*","pkg/dg-daemon/src/server/*","pkg/dg-daemon/__tests__/**/*overwatch*"]
    agents:
      primary: js
      qa: [qa-code, security]
      proxy: codex
  - id: 3
    name: "dg-agent-overwatch-commands"
    depends_on: [1]
    files: ["pkg/dg-agent/src/commands.ts","pkg/dg-agent/src/overwatch.ts","pkg/dg-agent/__tests__/overwatch.spec.ts"]
    agents:
      primary: js
      qa: [qa-code]
      proxy: codex
  - id: 4
    name: "extension-overwatch-page"
    depends_on: [1,2]
    files: ["pkg/extension/entrypoints/overwatch/*","pkg/extension/lib/background/chat.ts","pkg/extension/lib/chat-messages.ts","pkg/extension/lib/features/overwatch*.ts","pkg/extension/__tests__/overwatch-page.spec.ts"]
    agents:
      primary: js
      qa: [qa-code]
      proxy: codex
  - id: 5
    name: "overwatch-skill-and-phone-snapshot"
    depends_on: [3]
    files: ["plugins/dg/skills/overwatch/SKILL.md","pkg/skills-cli/src/commands/overwatch-snapshot.ts","pkg/skills-cli/__tests__/*overwatch*"]
    agents:
      primary: js
      qa: [reviewer]
      proxy: codex
permissions:
  run_commands: true
  git_push: false
  gh_pr_create: false
  auto_cleanup_worktree: false
  slice_commits: true
  housekeeping_commit: true
---

# Overwatch board

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

### Slice 1 — overwatch-wire-types

#### Engineering
- [ ] Add OverwatchLane, OverwatchMerge, OverwatchBoard types and OverwatchStage enum review|ci|e2e|merge|done
- [ ] Add CLI frames cli-overwatch-set, cli-overwatch-remove, cli-overwatch-merged, cli-overwatch-launch, cli-overwatch-open, cli-overwatch-snapshot
- [ ] Add outbound-only chat frames overwatch-state and overwatch-open (sessionId __overwatch__); extend CHAT_FRAME_TYPES and validateFrameBody, NOT INBOUND_FRAME_TYPES
- [ ] Export validateOverwatchLane and validateOverwatchAction for daemon HTTP and cli handlers; limits chat<=40, task<=80, note<=2000; url must start with https://claude.ai/

#### Testing Criteria
##### Contracts
- [ ] ### Contracts: valid overwatch frames pass validateChatFrame; bad stage, oversize field or non-claude url fail with an error naming the field; validateOverwatchAction requires a note for reject
- [ ] Each new frame has a valid and an invalid case

#### Acceptance Criteria
- [ ] Given a well-formed overwatch-state frame, validateChatFrame accepts it
- [ ] Given a reject action without a note, validateOverwatchAction throws naming note

### Slice 2 — daemon-board-store-and-routes

#### Engineering
- [ ] Schema v9: overwatch_lanes, overwatch_merges, overwatch_settings with encrypted free-text columns per existing pattern
- [ ] Store fns upsertLane, removeLane, addMerge, setLaunch, getBoard; merges filtered to local today on read
- [ ] Reserved __overwatch__ session row via ensureSessionRow like SCHEDULER_SESSION_ID
- [ ] cli-overwatch-* handlers on /cli; lane publisher = calling session agentIdentity
- [ ] Broadcast overwatch-state to all extension sockets after every change
- [ ] GET /overwatch and POST /overwatch/action behind refuseForeignOrigin + host guard
- [ ] Action writes one agent_messages row, sender __overwatch__ / overwatch-board, recipient lane publisher, JSON body {overwatch:{chat,action,note}}
- [ ] cli-overwatch-open pushes overwatch-open; no extension connected returns cli error extension not connected

#### Testing Criteria
##### Contracts
- [ ] ### Contracts: set then getBoard returns the lane; remove drops it; merges before today excluded; action yields exactly one agent_messages row whose body parses to {overwatch:{chat,action,note}}; unknown lane 404; foreign Origin refused; migration runs from v8
- [ ] Broadcast reaches connected extension sockets after set, remove, merged, launch

#### Acceptance Criteria
- [ ] Given a lane published by identity X, when the board posts approve, then X receives it via dg-agent recv

### Slice 3 — dg-agent-overwatch-commands

#### Engineering
- [ ] dg-agent overwatch set <chat> [--task --stage --mr --eta --next --url --background]
- [ ] dg-agent overwatch remove <chat>, merged <mr> <title>, launch --go-live <iso> [--go-no-go <iso>], open, snapshot [--json]
- [ ] Reuse CliClient and session resolution; clear errors when daemon down or extension not connected

#### Testing Criteria
##### Contracts
- [ ] ### Contracts: each command sends exactly one frame with parsed fields; invalid stage exits 2 before sending; snapshot prints board JSON
- [ ] Stub CliClient tests per command

#### Acceptance Criteria
- [ ] Given dg-agent overwatch set print --stage e2e --mr !298, the daemon receives one cli-overwatch-set with those fields

### Slice 4 — extension-overwatch-page

#### Engineering
- [ ] New WXT page entrypoints/overwatch reproducing prototype variant E from /home/detailedghost/code/dg-ai/.agents/prototype/overwatch-v2/manifest.md
- [ ] Initial load via GET /overwatch, live updates via background-relayed overwatch-state; patchKeyedList lane diffing
- [ ] Countdown from goLive, need-you count = lanes with next, footer background lanes and merges, empty state, daemon-down pill
- [ ] One Actions button per lane: menu Reply (inline box + Send), Approve, Reject (note required) -> POST /overwatch/action; sent state or error toast
- [ ] Background handles overwatch-open: focus existing overwatch.html tab or create it
- [ ] Brutalist-neon tokens light and dark; 390px wide with no horizontal scroll; no word-breaking labels; no dashes

#### Testing Criteria
##### Contracts
- [ ] ### Contracts: an overwatch-state frame renders one lane per chat with the correct active stage; a later frame without a lane removes it with no reload; Actions Approve sends one POST /overwatch/action; overwatch-open with an existing tab focuses it and creates none
- [ ] happy-dom tests for render, update, remove, actions, open/focus

#### Acceptance Criteria
- [ ] Given the board is open, when an agent runs dg-agent overwatch set, then the lane updates live

### Slice 5 — overwatch-skill-and-phone-snapshot

#### Engineering
- [ ] dg:overwatch skill: dg-agent start --agent-identity first, publish lanes, handle actions from dg-agent recv, open board, republish phone snapshot
- [ ] dg-skills overwatch-snapshot renders snapshot JSON to self-contained read-only HTML in the variant E look with session links and an as-of time
- [ ] Throttle state under the scratch root: max 1 publish per 2 min; the overwatch Claude chat publishes via the Artifact tool, the CLI only renders
- [ ] Add --overwatch section to ~/.claude/skills/stat/SKILL.md (outside repo) calling dg-agent overwatch open and the skill flow

#### Testing Criteria
##### Contracts
- [ ] ### Contracts: snapshot HTML has one tile per lane with its link or no link; no external URLs; throttle skips a publish within 2 min and reports it
- [ ] Renderer unit test

#### Acceptance Criteria
- [ ] Given a board with 4 lanes, overwatch-snapshot outputs HTML with 4 tiles

## Slice Summaries

## Agent Notes

## Issues Remediation
