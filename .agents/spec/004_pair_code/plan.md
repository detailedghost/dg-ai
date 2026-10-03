---
feature: "Pair code and release pipeline fix"
feature_snake_case: pair_code
date: "2026-10-02"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "daemon-pair-code"
    depends_on: []
    files: ["pkg/dg-daemon/src/**","pkg/dg-daemon/__tests__/**","pkg/common/src/**","pkg/common/__tests__/**"]
    agents:
      primary: js
      qa: [qa-code, security]
      proxy: codex
  - id: 2
    name: "extension-pair-ui"
    depends_on: [1]
    files: ["pkg/extension/**"]
    agents:
      primary: js
      qa: [qa-code]
      proxy: codex
  - id: 3
    name: "release-pipeline-fix"
    depends_on: []
    files: [".github/workflows/**","pkg/*/package.json","plugins/dg/**"]
    agents:
      primary: devops
      qa: [qa-devops]
      proxy: codex
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: false
  slice_commits: true
  housekeeping_commit: true
---

# Pair code and release pipeline fix

## Purpose
Let the user pair the dg extension from the extension itself with a short one-time code printed by the CLI, instead of opening a dg-agent start link. The code proves the user has local terminal access, so pairing stays as safe as today. Also fix the release pipeline so merges to master ship new binaries and extension builds again.

## Scope
### Included
- dg-daemon pair command: prints a 6 digit one-time code, valid 5 minutes, max 5 attempts, stored hashed in DG_HOME with mode 0600
- Daemon POST /pair: validates the code (constant time, single use, expiry, attempts), refuses when another origin is pinned, then mints a session bootstrap for the extension
- Extension Pair UI: Not paired state with a Pair button, daemon discovery on ports 47823 to 47832, code entry, success and error states
- Background feeds the returned bootstrap into the existing marker-captured connect path, so the existing handshake pins the origin
- The overwatch board and chat page show Not paired with a Pair button when the daemon is reachable but the extension is not connected
- Release pipeline: replace retired macos-13 smoke runners, bump all package versions to 1.10.0 so releases publish
### Excluded
- Removing the existing dg-agent start link flow (it stays)
- Remote or non-loopback pairing
- Multiple pinned origins

### Slice 1 — daemon-pair-code

#### Engineering
- [ ] dg-daemon pair subcommand next to origin show/clear: generates a 6 digit code from a CSPRNG, writes {hash, salt, expiresAt, attemptsLeft} to DG_HOME/pairing.json with mode 0600, prints the code and the expiry; works whether or not the daemon is running
- [ ] POST /pair on the daemon: loopback host guard; extension-scheme Origin required (a browser http/https Origin is refused); body {code}; constant-time compare; single use; 5 minute expiry; 5 attempts then the record is deleted; when a different origin is already pinned return 409 with a hint to run dg-daemon origin clear
- [ ] On success mint a session bootstrap {port, sessionId, token} the same way POST /start does, with agentIdentity 'extension' and a workset label 'paired'; the existing connect handshake then pins the origin
- [ ] Shared request and response types and validation in pkg/common

#### Testing Criteria
##### Contracts
- [ ] ### Contracts: valid code returns a bootstrap and the record is consumed; wrong code decrements attempts; expired code is refused; sixth attempt refused and record deleted; browser Origin refused; different pinned origin returns 409; pairing.json mode is 0600
- [ ] CLI test for dg-daemon pair output and file contents

#### Acceptance Criteria
- [ ] Given dg-daemon pair printed code C, when the extension posts C to /pair, then it receives a bootstrap and a second post of C is refused

### Slice 2 — extension-pair-ui

#### Engineering
- [ ] Pair UI reachable from the options page and from a Not paired state on the chat page and the overwatch board
- [ ] Discover the daemon via /healthz on 47823 to 47832, accept a 6 digit code, POST /pair, then pass the bootstrap to the background through the same path as a captured marker
- [ ] Clear states: daemon not running (tell the user to run dg-agent start or dg-daemon), wrong code with attempts left, expired, pinned to another extension (show the origin clear command), success
- [ ] Brutalist-neon tokens, light and dark, works at 390px, nowrap labels, no dash glyphs

#### Testing Criteria
##### Contracts
- [ ] ### Contracts: correct code leads to a background connect with the returned bootstrap; each error status shows its message; the Pair entry shows only when not connected
- [ ] happy-dom tests through the real background message path

#### Acceptance Criteria
- [ ] Given an unpaired extension and a running daemon, when the user enters the code from dg-daemon pair, then the extension connects and the board goes live

### Slice 3 — release-pipeline-fix

#### Engineering
- [ ] Replace the retired macos-13 smoke runner in dg-daemon-release.yml, dg-agent-release.yml and skills-release.yml with a supported Intel macOS runner label, keeping x64 coverage
- [ ] Bump every released package to 1.10.0 (extension, dg-daemon, dg-agent, skills-cli, plugin manifest if versioned) so the release jobs publish new tags
- [ ] Check ext-release for the earlier failure on 443fe2a and fix its cause if it still applies

#### Testing Criteria
##### Contracts
- [ ] ### Contracts: no workflow references macos-13; versions agree across packages; workflow YAML parses
- [ ] Any existing workflow or version consistency tests pass

#### Acceptance Criteria
- [ ] After merge, all four release workflows complete and publish v1.10.0 tags

## Slice Summaries

## Agent Notes

## Issues Remediation
