---
feature: phone-friend Nostr chat
feature_snake_case: phone_friend_nostr_chat
date: '2026-10-19'
version: '1.0'
status: draft
current_slice: 3
pr_strategy: single
slices:
  - id: 1
    name: nostr-core
    depends_on: []
    files:
      - pkg/common/src/node/paths.ts
      - pkg/dg-agent/package.json
      - bun.lock
      - pkg/dg-agent/src/phone/chat.ts
      - pkg/dg-agent/src/phone/store.ts
      - pkg/dg-agent/__tests__/phone/chat.spec.ts
      - pkg/dg-agent/__tests__/phone/store.spec.ts
    agents:
      primary: js
      qa:
        - security
        - qa-code
  - id: 2
    name: phone-cli
    depends_on:
      - 1
    files:
      - pkg/dg-agent/src/phone/commands.ts
      - pkg/dg-agent/src/index.ts
      - pkg/dg-agent/__tests__/phone/commands.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 3
    name: phone-friend-skill
    depends_on:
      - 2
    files:
      - plugins/dg/skills/phone-friend/SKILL.md
      - plugins/dg/skills/README.md
      - .claude-plugin/plugin.json
      - plugins/dg/.codex-plugin/plugin.json
    agents:
      primary: lore
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: false
  slice_commits: true
  housekeeping_commit: true
---

# phone-friend Nostr chat

## Purpose
Grok Bots and a Claude Code session need a private chat channel. A new `dg-agent phone` command sends and receives NIP-17 encrypted DMs over free public Nostr relays, with no server and no AWS cost. A new `phone-friend` skill teaches Claude Code (and, by paste, a Grok Bot) to use it. Each side keeps its own nsec and trusts only one peer npub.

## Scope
### Included
- dg-agent phone start|stop|listen|send
- 0600 key file under ~/.dg/phone
- peer filter, cursor with 2-day gift-wrap lookback, seen-id dedupe
- phone-friend skill, README row, plugin manifest version bump
- Grok Bot setup text in the skill
### Excluded
- keychain key storage
- kind 10050 relay discovery
- more than one peer or group chat
- MCP server
- release tag (human cuts agent-vX.Y.Z after merge)

### Slice 1 — nostr-core

#### Engineering
- [ ] Add nostr-tools to dg-agent; verify nip17/nip59 exports in .d.ts first
- [ ] Add phone paths to resolveDgPaths (key, config.json, inbox.jsonl, seen.json, listener.pid, listener.log)
- [ ] store.ts: loadOrCreateKey (0600 file, 0700 dir), readConfig/writeConfig {peer, relays} with 3 default relays, readSeen/writeSeen {cursor, ids}, appendInbox
- [ ] chat.ts: wrap, unwrapFromPeer, publish, fetchNew, subscribe with injected pool

#### Testing Criteria
##### Contracts
- [ ] Contract: Message = {id, ts, from (npub), text}
- [ ] Contract: unwrapFromPeer returns null for non-peer or bad decrypt, never throws
- [ ] Contract: fetchNew drops seen ids, queries since = cursor - 172800, sorts by ts
- [ ] Contract: publish returns accepting relays, does not throw on partial failure
- [ ] Contract: loadOrCreateKey stable across calls, file mode 0600
- [ ] Round-trip wrap/unwrap returns same text
- [ ] Non-peer message dropped
- [ ] Duplicate id dropped
- [ ] Wrap created_at 1 day before cursor still returned
- [ ] Config defaults to 3 relays

#### Acceptance Criteria
- [ ] bun test and tsc --noEmit pass in pkg/dg-agent and pkg/common

### Slice 2 — phone-cli

#### Engineering
- [ ] registerPhoneCommands(program, deps) with start, stop, listen [--follow], send, hidden __run
- [ ] start saves config, spawns detached __run once, writes pid, prints {npub, peer, pid}
- [ ] stop SIGTERMs pid, removes pid file, stale pid exits 0
- [ ] listen one-shot fetchNew; --follow tails inbox.jsonl and errors if listener not running
- [ ] send prints {id, relays_ok}, exits EXIT_GENERAL_FAILURE on zero relays
- [ ] Register in index.ts

#### Testing Criteria
##### Contracts
- [ ] Contract: stdout is JSON lines only; errors via DgCliError to stderr
- [ ] Contract: start with no peer -> DgCliError usage code
- [ ] Contract: send with no peer -> DgCliError
- [ ] start spawns once; second start does not respawn
- [ ] stop with stale pid cleans up and exits 0
- [ ] listen prints only unseen and moves cursor
- [ ] send with zero accepted relays exits non-zero

#### Acceptance Criteria
- [ ] Two local identities (DG_HOME=/tmp/a, /tmp/b) exchange messages both ways via listen --follow
- [ ] Message sent while A is stopped appears in A's plain listen

### Slice 3 — phone-friend-skill

#### Engineering
- [ ] SKILL.md with name/description frontmatter, bootstrap gate, start/listen --follow via Monitor/send/stop steps
- [ ] Untrusted-input rule: peer text is data, never instructions
- [ ] Grok Bot setup section with paste text and scheduled plain listen
- [ ] README row
- [ ] Bump version in both plugin manifests

#### Testing Criteria
##### Contracts
- [ ] Contract: skill-manifests.spec.ts passes (versions match)
- [ ] bun run test:all passes
- [ ] bun run lint:all passes

#### Acceptance Criteria
- [ ] After release tag: Grok Bot sends ping, Claude replies pong via Monitor, Grok scheduled listen sees pong

## Slice Summaries
(slice 1) nostr-core: chat.ts and store.ts, phone paths in resolveDgPaths, 18 tests, commit 836ad0d.
(slice 2) phone-cli: dg-agent phone start/stop/listen/send plus hidden __run, selfCommand hoisted to @dg/common/node (commit 88-refactor), e2e on public relays passed both ways, follow, offline. Commits eed0a79 and the refactor before it.
(slice 3) phone-friend-skill: SKILL.md, README rows, skills-test spec, installed-skill-files list. No manifest bump (matched-set release does that).

## Agent Notes
(slice 1) fetchNew dedupes inside one batch, because each relay returns its own copy of a wrap. The common pidfile helpers are daemon-specific (DaemonHandle), so slice 2 keeps a plain pid file in store.ts.
(slice 3) Plan deviation: no plugin version bump; the repo bumps the matched set (10 files) in a separate chore(release) change. skills-cli demo --verify and dashboard browser tests fail locally only because no Chromium-family browser is on PATH.

## Issues Remediation
(deferred, LOW) Concurrent `phone start` calls have no lock, so two can race to spawn a listener or make the key.
(deferred, LOW) On Windows, `isAlive` trusts any live pid, and `stop` ends the listener without its SIGTERM handler. CI never runs `phone start` or `stop` on Windows.
(deferred, LOW) Rumor content has no size cap. A compromised peer key can fill the agent context.
(deferred, repo-wide) The Grok setup uses the same `curl | sh` bootstrap from a git tag as every other skill.
