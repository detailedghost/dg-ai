---
feature: phone-friend v2
feature_snake_case: phone_friend_v2
date: '2026-10-19'
version: '1.0'
status: draft
current_slice: 4
pr_strategy: single
slices:
  - id: 1
    name: rename-and-verbs
    depends_on: []
    files:
      - pkg/dg-agent/src/phone-friend/**
      - pkg/dg-agent/__tests__/phone-friend/**
      - pkg/dg-agent/src/index.ts
      - pkg/common/src/node/paths.ts
      - pkg/common/__tests__/node-paths.spec.ts
    agents:
      primary: js
  - id: 2
    name: invite-and-dial
    depends_on:
      - 1
    files:
      - pkg/dg-agent/src/phone-friend/card.ts
      - pkg/dg-agent/src/phone-friend/chat.ts
      - pkg/dg-agent/src/phone-friend/store.ts
      - pkg/dg-agent/src/phone-friend/commands.ts
      - pkg/dg-agent/__tests__/phone-friend/card.spec.ts
      - pkg/dg-agent/__tests__/phone-friend/chat.spec.ts
      - pkg/dg-agent/__tests__/phone-friend/commands.spec.ts
    agents:
      primary: js
      qa:
        - security
        - qa-code
  - id: 3
    name: credential-store-key
    depends_on:
      - 2
    files:
      - pkg/dg-agent/src/phone-friend/keys.ts
      - pkg/dg-agent/src/phone-friend/commands.ts
      - pkg/dg-agent/src/phone-friend/store.ts
      - pkg/dg-agent/__tests__/phone-friend/keys.spec.ts
      - pkg/dg-agent/__tests__/phone-friend/commands.spec.ts
      - pkg/dg-agent/__tests__/phone-friend/store.spec.ts
    agents:
      primary: js
      qa:
        - security
  - id: 4
    name: skill-and-docs
    depends_on:
      - 3
    files:
      - plugins/dg/skills/phone-friend/SKILL.md
      - docs/phone-friend.md
      - pkg/skills-test/__tests__/phone-friend-skill.spec.ts
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

# phone-friend v2

## Purpose
Rename the CLI to `dg-agent phone-friend` with phone verbs (number, invite, dial, on, off, answer, voicemail, say), add one-time call cards so the other bot can call you with one pasted string, and keep the nsec in the dg credential store with a 0600-file fallback when no daemon runs.

## Scope
### Included
- phone-friend CLI group and phone verbs
- invite cards and dial with single-use secret
- credential-store key with grant read and file fallback and safe migration
- skill and docs rewrite
### Excluded
- old verb aliases
- manual npub pairing
- invite secret in the store
- version bump (1.16.0 not yet released)

### Slice 1 — rename-and-verbs

#### Engineering
- [ ] git mv src/phone and tests to phone-friend; rename register fn and path fields; dir ~/.dg/phone-friend
- [ ] verbs number/on/off/answer/voicemail/say; remove start/stop/listen/send; keep on --peer this slice only
- [ ] wording peer -> contact

#### Testing Criteria
##### Contracts
- [ ] Contract: number prints {npub, contact, key_store: file, listener}
- [ ] Contract: answer/voicemail keep listen --follow/listen behavior; say - reads stdin
- [ ] existing tests pass under new names

#### Acceptance Criteria
- [ ] bun test and tsc pass in dg-agent and common

### Slice 2 — invite-and-dial

#### Engineering
- [ ] card.ts encode/decode dgcall1 base64url JSON with validation
- [ ] store invite.json 0600 read/write/clear
- [ ] chat unwrapIncoming gate {contact, invite}; fetchNew/subscribe report call
- [ ] commands invite (restart listener) and dial; on accepts contact or invite; remove on --peer

#### Testing Criteria
##### Contracts
- [ ] Contract: card round-trip; expired/tampered/wrong prefix rejected
- [ ] Contract: right secret pairs sender and clears invite; reuse by another sender dropped
- [ ] wrong secret, expired invite, stranger with no invite dropped
- [ ] listener accepts call then delivers next contact message
- [ ] invite with existing contact: call replaces contact
- [ ] dial saves contact+relays and publishes one wrap with dg-call tag

#### Acceptance Criteria
- [ ] two DG_HOMEs: A invite+on+answer, B dial, A gets call:true hello, then chat both ways

### Slice 3 — credential-store-key

#### Engineering
- [ ] keys.ts loadKey/ensureKey with mode rule; migration with read-back; injected session/grant clients
- [ ] commands await key loading; __run reads through grant
- [ ] number reports key_store

#### Testing Criteria
##### Contracts
- [ ] Contract: with session first key goes to store + grant, no file
- [ ] Contract: no daemon -> 0600 file
- [ ] file + session migrates; file deleted only after matching read-back; failed read-back keeps file
- [ ] store mode + daemon down -> DgCliError, no new key
- [ ] no error contains the nsec

#### Acceptance Criteria
- [ ] real temp daemon: number shows key_store store; on uses grant; dial from file-mode identity works

### Slice 4 — skill-and-docs

#### Engineering
- [ ] rewrite SKILL.md: give out your number, pick up, key storage, Grok paste text with dial and voicemail, card safety
- [ ] update docs/phone-friend.md
- [ ] update skill test for new verbs

#### Testing Criteria
##### Contracts
- [ ] Contract: skill test checks verbs, heredoc rule, no old verbs

#### Acceptance Criteria
- [ ] test:all (minus Chromium), lint:all, markdownlint, pin-bootstrap-tag --check pass

## Slice Summaries
(slice 1) rename-and-verbs: phone-friend group, number/on/off/answer/voicemail/say, paths phoneFriend*, peer->contact. 41 phone tests.
(slice 2) invite-and-dial: card.ts, invite.json, gate with call admission in time order, invite/dial commands, on needs contact or invite. 61 phone tests, relay e2e passed.
(slice 3) credential-store-key: keys.ts mode rule, migration with read-back, grant-read listener, --session via preAction. 251 dg-agent tests; real temp-daemon e2e passed.
(slice 4) skill-and-docs: SKILL.md and docs rewritten, skill test updated. test:all clean except known Chromium-only specs; lint:all clean.

## Agent Notes
(slice 3) A source-run dg-daemon with a temp DG_HOME on Linux writes a keychain entry (secret-tool, service dg-server, account chat-store-kek:<hash of DG_HOME>). Clear it after any manual e2e.

## Issues Remediation