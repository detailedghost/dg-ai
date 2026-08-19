---
feature: Chat Harness
feature_snake_case: chat_harness
date: '2026-08-18'
version: '1.0'
status: in-progress
current_slice: 8
pr_strategy: single
slices:
  - id: 1
    name: shared-contracts
    depends_on: []
    files:
      - pkg/common/src/chat-format.ts
      - pkg/common/src/assert.ts
      - pkg/common/src/proto-format.ts
      - pkg/common/src/node/**
      - pkg/common/src/index.ts
      - pkg/common/package.json
      - pkg/common/tsconfig.json
      - pkg/common/__tests__/chat-format.spec.ts
      - pkg/common/__tests__/node-paths.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 2
    name: dg-server-skeleton
    depends_on:
      - 1
    files:
      - pkg/dg-server/package.json
      - pkg/dg-server/tsconfig.json
      - pkg/dg-server/bunfig.toml
      - pkg/dg-server/src/index.ts
      - pkg/dg-server/src/server/**
      - pkg/dg-server/src/session/**
      - pkg/dg-server/src/utils/**
      - pkg/dg-server/scripts/**
      - pkg/dg-server/__tests__/server/**
      - pkg/dg-server/__tests__/session/**
      - pkg/dg-server/__tests__/utils/**
      - bun.lock
    agents:
      primary: js
      effort: xhigh
      qa:
        - security
        - qa-code
  - id: 3
    name: sqlite-store-and-encryption
    depends_on:
      - 1
      - 2
    files:
      - pkg/dg-server/src/store/**
      - pkg/dg-server/src/crypto/**
      - pkg/dg-server/__tests__/store/**
      - pkg/dg-server/__tests__/crypto/**
    agents:
      primary: js
      effort: xhigh
      qa:
        - security
        - dba
  - id: 4
    name: extension-marker-and-background
    depends_on:
      - 1
    files:
      - pkg/extension/utils/chat-marker.ts
      - pkg/extension/entrypoints/chat-marker-capture.content.ts
      - pkg/extension/lib/chat-messages.ts
      - pkg/extension/lib/background/chat.ts
      - pkg/extension/lib/background/index.ts
      - pkg/extension/lib/background/recording.ts
      - pkg/extension/entrypoints/background.ts
      - pkg/extension/wxt.config.ts
      - pkg/extension/__tests__/chat-marker.spec.ts
      - pkg/extension/__tests__/background-chat.spec.ts
    agents:
      primary: js
      qa:
        - security
        - qa-code
  - id: 5
    name: extension-chat-client
    depends_on:
      - 4
    files:
      - pkg/extension/lib/features/chat-client.ts
      - pkg/extension/lib/features/chat-sessions.ts
      - pkg/extension/lib/features/chat-transcript.ts
      - pkg/extension/__tests__/chat-client.spec.ts
      - pkg/extension/__tests__/chat-sessions.spec.ts
      - pkg/extension/__tests__/chat-transcript.spec.ts
    agents:
      primary: js
      qa:
        - security
        - qa-code
  - id: 6
    name: extension-chat-page
    depends_on:
      - 5
    files:
      - pkg/extension/entrypoints/chat/**
      - pkg/extension/lib/features/chat-node.ts
      - pkg/extension/__tests__/chat-node.spec.ts
      - pkg/extension/__tests__/chat-page.spec.ts
    agents:
      primary: js
      qa:
        - design
        - qa-code
      proxy: codex
      proxy_skills:
        - polish
        - standard-test
    prototype:
      path: prototype/slice_6_index.html
      variant: A
  - id: 7
    name: agent-facing-cli
    depends_on:
      - 2
      - 3
    files:
      - pkg/dg-server/src/commands/**
      - pkg/dg-server/src/manifest/**
      - pkg/dg-server/__tests__/commands/**
    agents:
      primary: js
      qa:
        - qa-code
      proxy: codex
      proxy_skills:
        - polish
        - standard-test
  - id: 8
    name: command-and-subagent-dispatch
    depends_on:
      - 5
      - 6
      - 7
    files:
      - pkg/dg-server/src/dispatch/**
      - pkg/extension/lib/features/chat-autocomplete.ts
      - pkg/dg-server/__tests__/dispatch/**
      - pkg/extension/__tests__/chat-autocomplete.spec.ts
    agents:
      primary: js
      effort: xhigh
      qa:
        - security
        - qa-code
  - id: 9
    name: asset-staging-and-serving
    depends_on:
      - 3
      - 6
    files:
      - pkg/dg-server/src/assets/**
      - pkg/extension/entrypoints/options/**
      - pkg/extension/lib/config.ts
      - pkg/dg-server/__tests__/assets/**
      - pkg/extension/__tests__/asset-settings.spec.ts
    agents:
      primary: js
      qa:
        - security
        - qa-code
  - id: 10
    name: distribution-skill-and-ci
    depends_on:
      - 1
      - 2
      - 3
      - 4
      - 5
      - 6
      - 7
      - 8
      - 9
      - 11
    files:
      - plugins/dg/skills/chat/**
      - plugins/dg/skills/README.md
      - .github/workflows/dg-server-blt.yml
      - .github/workflows/dg-server-release.yml
      - pkg/skills-cli/src/commands/install.ts
      - pkg/skills-cli/src/utils/lib.ts
      - pkg/skills-cli/bootstrap.sh
      - pkg/skills-cli/bootstrap.ps1
      - pkg/skills-test/**
      - README.md
      - docs/DEVELOPER.md
      - docs/AGENT-INSTALL.md
      - .agents/monolith.md
    agents:
      primary: devops
      qa:
        - qa-devops
        - lore
      proxy: codex
      proxy_skills:
        - polish
        - standard-test
  - id: 11
    name: extension-canvas-surface
    depends_on:
      - 6
    files:
      - pkg/extension/lib/features/chat-canvas.ts
      - pkg/extension/__tests__/chat-canvas.spec.ts
    agents:
      primary: js
      qa:
        - design
        - qa-code
      proxy: codex
      proxy_skills:
        - polish
        - standard-test
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
---

# Chat Harness

## Purpose
Give a terminal coding agent a browser chat window to converse with the user through. A new persistent daemon (pkg/dg-server) hosts a loopback HTTP+WebSocket server, an encrypted SQLite store, and a session registry; a new dg-ai-extension page (entrypoints/chat/) is its client, presenting live sessions in the project's brutalist-neon theme as a workset-grouped rail beside one focused thread, with an optional pan/zoom canvas as a secondary spatial view. The agent blocks on a timeout-bounded recv, replies with whole messages plus progress frames, can spawn additional background chats bound to different agents, publishes a manifest of $-prefixed local commands the daemon executes itself and @-prefixed subagents it routes back to the model, and stages created assets the daemon serves over the same loopback origin.

## Scope
### Included
- New workspace package pkg/dg-server, compiled to a dg-server binary the same way pkg/skills-cli builds dg-skills
- Single daemon hosting MANY sessions over ONE loopback WebSocket, bound to a fixed default port with a deterministic fallback range plus an unauthenticated GET /health carrying only daemon, protocolVersion and instanceId for rediscovery
- A capability-set authorization model: an authenticated socket accumulates sessionId-to-token capabilities, every inbound frame is validated against the exact pair, and outbound frames never carry a token
- SQLite (bun:sqlite, WAL, PRAGMA user_version migrations) as the ONLY store of record, with claim-lease read semantics so a non-listening agent misses nothing
- AES-GCM envelope encryption: a per-database data key stored wrapped by a keychain or file key-encryption key, with identity-first key resolution that refuses to start on a fingerprint mismatch rather than silently minting a second key
- A session lifecycle with an explicit terminal close that invalidates the token, releases any parked blocking recv, and triggers asset cleanup
- New extension page entrypoints/chat/: a workset-grouped rail beside one focused thread, with transcripts, composers, agent identity, and RUNNING / NEEDS YOU badges on the existing brutalist-neon theme tokens — the layout settled by prototype
- An OPTIONAL pan/zoom canvas as a secondary spatial view toggled from the rail, with keyboard and non-drag pointer repositioning
- Worksets: an optional label plus an orchestrator-or-agent role on each session, so the rail groups sessions and pins the orchestrator; the daemon stores and echoes both without interpreting them
- Loopback-scoped content script capturing a #_chat= bootstrap marker, relayed to the background service worker which owns the WebSocket
- Agent-facing CLI verbs over a dedicated /cli WebSocket route: recv --block --timeout with a distinct timeout exit code, send, status, spawn, stage, close, and manifest
- $ commands executed by the daemon directly from typed argv manifests, results returned as one buffered terminal frame without waking the model
- @ subagent mentions resolved against the manifest and persisted as queued messages the next recv claims
- Session-scoped asset staging under a daemon-authoritative, settings-page-configurable directory with per-OS defaults, retrieved by authenticated fetch and rendered from a blob URL
- plugins/dg/skills/chat/SKILL.md exposing dg:start
- New path-filtered CI workflows building and releasing the dg-server binary under a server-v* tag, with a stub build workflow landing early so slices 2-9 are gated
- install and bootstrap fetching all three artifacts prebuilt from GitHub Releases: dg-skills, dg-server, and the extension zip
- Four /prototype layout variations for the canvas, built on the existing theme tokens, with the accepted layout recorded as prose in Code Structure
### Excluded
- MCP registry and the aggregating MCP proxy — deferred to bundle 2
- Skill-plugin drop-in folder discovery as a second source of $ commands — deferred to bundle 2
- Migrating dg:demo, dg:proto and dg:browser off browser-downloads polling and one-shot URL markers onto the daemon channel — deferred to bundle 3
- Dexie and any browser-side IndexedDB store for chat; pkg/extension/utils/recording-db.ts is left untouched
- Token-by-token streaming of agent replies; progress frames cover the wait instead
- Chunked or incremental $ output frames; results buffer to one terminal frame — deferred to bundle 2
- Native messaging as a transport
- Sandboxing or resource isolation of $ commands; Bun.spawn offers only uid and gid and is ENOTSUP on Windows
- Key rotation tooling; envelope encryption makes the mechanism cheap to add later but no rekey verb ships here
- Canvas edges wiring nodes together for cross-agent context reads
- Canvas node types other than chat — no terminal, editor, diff, browser, sticky or group nodes
- Subagent fan-out visualization on the canvas as subagents spawn
- Deriving worksets from /spec bundles, or auto-attaching assigned slice agents as members
- An orchestrator that routes work to member sessions and relays their answers back
- Any change to how the demo tour, recorder, prototype or tab-grouping features behave, beyond routing the shared toolbar-action listener
- A git worktree and a pull request — this bundle is built directly on master

### Slice 1 — shared-contracts

#### Engineering
- [x] Add pkg/common/src/chat-format.ts with a ChatFrame discriminated union keyed on `type`, following the Verdict / validateVerdict idiom in src/types.ts and src/proto-format.ts
- [x] Cover these frame types: user message, agent message, progress/status, command invocation, command result, manifest publish, session list, session create, session closed, history request, history response, config get, config set, and error
- [x] Authorization contract: every INBOUND frame carries a sessionId and token pair validated against the socket's capability set; OUTBOUND frames carry sessionId only and never a token
- [x] Carve out the two pre-capability cases explicitly: a session-create request authenticates with the REQUESTING session's pair and returns the new session's id and token in a nested response field, and the /cli route's pre-session frames
- [x] Add hand-rolled validateChatFrame plus per-frame narrowing helpers using the existing requireX/fail assertion style — no schema library, matching proto-format.ts
- [x] Extract fail, isRecord and the requireX helpers from proto-format.ts into pkg/common/src/assert.ts and have both format modules import them
- [x] Add a client-generated message id on the user-message frame plus an ack frame, so delivery can be deduplicated idempotently
- [x] Add explicit state running | awaiting-input | agent-gone to the progress/status frame — RUNNING versus NEEDS YOU must never be inferred from silence
- [x] Add protocolVersion to the frame envelope plus a connect handshake; version it by hand, independent of the package version
- [x] Add an optional attachment field carrying an asset id on the agent-message frame; do NOT embed asset URIs in message bodies, which are encrypted and therefore unindexable
- [x] Add a resolved-subagent-name field on the user-message frame, left absent when an @ mention does not resolve
- [x] Give the session handle an optional workset label and a role of orchestrator or agent, so the rail can group sessions and pin the orchestrator
- [x] CommandEntry declares argv as string[] — never a command string — plus a display label distinct from argv and typed params slots; a placeholder occupies a WHOLE argv element
- [x] Split the session handle into two validated types: DaemonHandle (pid, port, instanceId, versions) for the singleton lockfile, and SessionBootstrap (port, sessionId, token, agentIdentity) for the marker; the lockfile must NEVER contain a session token
- [x] Add validateSessionHandle for each, so slices 2 and 4 parse the lockfile and marker through one agreed function
- [x] Publish fixed v1 size limits as shared constants: max WebSocket payload, max message body, max manifest, max asset
- [x] Add pkg/common/src/node/paths.ts resolving one uniform ~/.dg layout under homedir() on all three platforms — per-OS means seam resolution only, matching protoScratchPath and slice 10's ~/.dg/bin
- [x] Pin the resolver's returned shape by name: lockfilePath, dbPath, keyPath, assetsDir, sessionsDir, logPath, plus a 0700 state directory
- [x] DG_HOME is the ONLY root override; AI_SCRATCH_DIR must not affect the persistent root
- [x] Hoist isWSL, run, tryOpen and openers into pkg/common/src/node/**, and add runCapture(cmd, args, {stdin}) returning status, stdout and stderr — the existing run() throws, merges streams and trims, all three fatal to a keychain backend
- [x] Expose it as a new ./node subpath export in pkg/common/package.json, kept OUT of the . barrel so no node: import can reach the extension's Vite bundle
- [x] Re-export chat-format and assert from src/index.ts; leave src/node/** unreferenced by the barrel
- [x] Reuse the barrel-exported validateProtoIdentifier for subagent-name shape rather than a second regex

#### Testing Criteria
##### Contracts
- [x] Contract: validateChatFrame accepts every valid frame type and rejects unknown discriminants and a missing sessionId
- [x] Contract: an inbound frame whose sessionId and token pair is not in the capability set is rejected, and an outbound frame carrying a token is rejected as malformed
- [x] Contract: a session-create request validates against the requesting pair and returns the new id and token nested, not at the envelope level
- [x] Contract: validateCommandManifest accepts argv arrays with typed param slots and rejects any entry declaring a command string
- [x] Contract: validateSessionHandle accepts a DaemonHandle and a SessionBootstrap and rejects a lockfile shape containing a token
- [x] Contract: a session handle validates with and without a workset label, and rejects an unknown role value
- [x] Contract: @dg/common/node resolves the documented ~/.dg paths on win32, darwin and linux via injected platform and homedir seams, mirroring how proto-paths.ts takes SystemSeams
- [x] Contract: DG_HOME overrides the root and AI_SCRATCH_DIR does not
- [x] Contract: a frame exceeding the published max-payload constant is rejected by the validator
- [x] Importing @dg/common (the . barrel) pulls in no node: builtin — assert by static inspection of the barrel's transitive imports
- [x] Round-trip: a frame serialized to JSON and re-validated is deep-equal to the original
- [x] runCapture returns a non-zero status with stdout and stderr separated instead of throwing

#### Acceptance Criteria
- [x] Given the extension's Vite build, when bun run --filter='./pkg/extension' build runs, then it succeeds with no node: polyfill and no reference to src/node/** — tsc --noEmit does NOT catch this because a wildcard path mapping resolves the subpath
- [x] Given a frame whose sessionId and token pair is unknown to the socket, when it is validated, then it is rejected naming the failure
- [x] Given each supported platform, when the ~/.dg resolver runs, then it returns the documented paths and a 0700 state directory
- [x] bun run --filter='./pkg/common' test and lint both pass

### Slice 2 — dg-server-skeleton

#### Engineering
- [x] Create pkg/dg-server as a workspace package mirroring pkg/skills-cli's package.json and tsconfig.json exactly: commander entry, bun build --compile --outfile dist/dg-server, lint via tsc --noEmit, test via bun test
- [x] Update bun.lock for the new workspace member — CI installs with --frozen-lockfile, so an unupdated lockfile fails the first workflow run before lint or test
- [x] Implement the daemonize path: start re-execs process.execPath on a hidden __serve subcommand with detached true, stdio ignore, unref() and windowsHide on win32, then polls GET /health for its own instanceId before printing the URL
- [x] Bind hostname 127.0.0.1 explicitly (Bun defaults to 0.0.0.0), ignore PORT and BUN_PORT, and never set reusePort — reusePort lets two daemons bind one port and load-balance between them
- [x] Bind a fixed default high port with a deterministic 8-to-10 port fallback range, published as a @dg/common constant; a second Bun.serve on a bound port throws, which gives the cold-start mutex for free
- [x] Serve GET /health returning only daemon, protocolVersion and instanceId, and 204 to any caller failing the Host or Origin check
- [x] Serve GET /start as the bootstrap page; the marker lives ONLY in the fragment of the URL the CLI prints — a server-injected marker cannot work because document_start runs before inline script, and it would exfiltrate a live token to any local GET
- [x] Implement the session registry: start registers a session with an id, a minted token, a realpath-resolved cwd, and an optional agent identity, workset label and role, then returns or opens the marked bootstrap URL
- [x] Store and echo the workset label and role without interpreting them — grouping is the page's job, and the daemon must not couple to the /spec bundle format
- [x] Handle a session-create frame from a connected page so a chat can be started from the canvas, returning the new session's id and token nested in the response
- [x] Implement the session state machine active to closed, terminal, with three legitimate closers: CLI verb, canvas frame, daemon shutdown. On close mark the row, emit session closed to all sockets, invalidate the token with a distinct reason, release any parked blocking recv with a distinct closed result, trigger asset cleanup, and retain the transcript
- [x] Implement the capability-set model: a socket accumulates sessionId-to-token capabilities, gaining entries only via a newly captured bootstrap or an authenticated session-create response, and every inbound frame is validated against the exact pair
- [x] Two upgrade routes: /ws requires an extension-scheme Origin, /cli requires a session token and REJECTS any browser Origin, so the two client classes never share an auth path
- [x] Trust-on-first-use origin pinning: accept the first extension-scheme origin that completes a token-authenticated handshake, pin it in ~/.dg/config.json and refuse mismatches after. Document honestly that Origin is attacker-controlled from any local non-browser process and that the token is the sole access control
- [x] Require the Host header to be exactly 127.0.0.1 or localhost with the bound port on every request and upgrade — DNS-rebinding defense the Origin check does not provide
- [x] Session token at least 128 bits from a CSPRNG, compared with timingSafeEqual, never logged, with the connection closed after a small failed-frame budget
- [x] Write the session token to ~/.dg/sessions/<id>.json mode 0600 inside a 0700 directory with a DG_SESSION_TOKEN override; the lockfile holds a DaemonHandle only and never a token
- [x] Write the lockfile via a temp file plus rename(), and reclaim a lockfile whose daemon does not answer /health with a matching instanceId — pid liveness is wrong in both directions because pids recycle
- [x] Idle-TTL self-exit predicate is zero registered sessions AND zero open connections for the whole window; an open socket or an in-flight blocking recv pins the daemon
- [x] Refuse to start on WSL in NAT networking mode, naming the .wslconfig networkingMode=mirrored fix — the loopback design is only reachable from a Windows-side browser under mirrored mode
- [x] Enforce the shared v1 size limits at the transport boundary before JSON parsing, returning a distinct oversized error with no store side effects
- [x] One createSerialQueue per socket, awaiting ServerWebSocket drain, with errors surfaced via onError — a daemon-wide instance head-of-line-blocks every session
- [x] Set both Bun timeouts explicitly: HTTP idleTimeout defaults to 10s and caps at 255, and WebSocket defaults to 120s with sendPings
- [x] Typed error carrying its own exit code in src/index.ts's top-level handler, defaulting to 1 — a blanket exit(1) forecloses slice 7's distinct timeout code
- [x] Size-capped ~/.dg/dg-server.log, and status reporting bound port, key source, last error, WSL networking mode, session count and all four versions: package, protocol, user_version and extension
- [x] Expose a keySource seam in the status renderer that slice 3 contributes describeKeySource() into, so slice 3 never edits slice 2's merged files
- [x] Gate daemon attach on protocolVersion, never on the package version; on mismatch refuse and print remediation naming how many sessions a stop would end, and never auto-restart a shared daemon
- [x] DG_HOME and DG_PORT test seams — contract tests drive the compiled binary as a subprocess where injected seams are unreachable, and without these bun test clobbers the developer's real ~/.dg and daemon
- [x] Commit pkg/dg-server/scripts/verify-wsl-loopback.ts as the evidence artifact for the WSL-to-Windows loopback assumption; no CI runner can host the pair

#### Testing Criteria
##### Contracts
- [x] Contract: dg-server start on a cold machine binds the fixed port, writes a token-free lockfile, and prints a bootstrap URL whose fragment decodes to the registered session
- [x] Contract: a second dg-server start reuses the live daemon and registers a second session rather than binding a second port
- [x] Contract: GET /start returns no session data in its body, and the marker exists only in the printed URL's fragment
- [x] Contract: a socket may only act on sessions in its capability set, and session A's pair cannot address session B
- [x] Contract: a session-create frame bearing an unknown or closed session's token is refused and creates nothing
- [x] Contract: an upgrade on /cli bearing a browser Origin is refused, and an upgrade on /ws without an extension-scheme Origin is refused
- [x] Contract: a request whose Host header is not the loopback authority is refused
- [x] GET /health returns only the three published fields and 204s a non-loopback caller
- [x] The daemon is not reachable on any non-loopback local address, and reusePort is never set
- [x] A lockfile whose daemon does not answer /health with a matching instance id is reclaimed, and a live one is not
- [ ] Idle-TTL does not fire while a page is connected but idle, nor while a blocking recv is parked
- [x] Repeated invalid frames close the connection, and no rejected token appears in log output
- [x] A payload exceeding the max-payload constant is rejected before JSON parsing with no store write
- [x] A protocol-version mismatch refuses with a message distinct from a schema-too-new refusal
- [x] Startup on NAT-mode WSL refuses with the mirrored-mode remediation

#### Acceptance Criteria
- [ ] Given a Windows-side browser and a WSL-side daemon in mirrored networking mode, when the printed loopback /start URL is opened, then the page loads and a WebSocket connects — proven by the committed verify-wsl-loopback.ts probe, not by CI
- [x] Given two repos, when dg:start runs in each, then one daemon process holds two registered sessions on one port with separate tokens
- [x] Given a killed daemon, when dg-server status runs, then it reports no live daemon and leaves no stale lockfile behind
- [ ] Given a session close, when an agent is parked in a blocking recv on it, then that recv returns a distinct closed result rather than running to timeout
- [x] bun run --filter='./pkg/dg-server' test and lint both pass, and bun install --frozen-lockfile succeeds

### Slice 3 — sqlite-store-and-encryption

#### Engineering
- [x] Open the database under the ~/.dg state directory with bun:sqlite, Bun strict true, SQLite STRICT on every CREATE TABLE, PRAGMA journal_mode = WAL, PRAGMA foreign_keys = ON outside any transaction, and an explicit busy_timeout
- [x] Create the state directory 0700 and assert its mode at startup — the main database, -wal, -shm and any VACUUM INTO output are all created 0644 and come and go on SQLite's schedule, so only the directory contains them
- [x] Tables: sessions, messages, status_events, assets, command_invocations and crypto_meta
- [x] crypto_meta holds format_version, key_id (a non-secret hkdfSync fingerprint of the key-encryption key), key_source and the wrapped data key
- [x] Envelope encryption: generate a random per-database data key, store it wrapped by the keychain or file key-encryption key, and encrypt all record content with the unwrapped data key
- [x] Identity-first key resolution: read crypto_meta.key_id, collect candidates from every source that answers, use the one whose fingerprint matches, and REFUSE TO START when none matches, naming recorded versus resolved source and id. Mint and store only when no crypto_meta row exists
- [x] Mint randomBytes(32) and WRITE it into the keychain when reachable — a resolution path that never writes leaves the keychain branch dead
- [x] Name four key sources and treat unreachable as distinct from absent for each: secret-tool on Linux, which exits 1 with empty stdout for absent AND exits 1 when the session bus is unreachable even though the secret exists; security on macOS, with a GUI ACL prompt hazard under a detached daemon and no secrets in argv; DPAPI over ~/.dg/key.dpapi on Windows, reported as protected file rather than keychain; and a plain file
- [x] Mint the fallback key file with O_CREAT, O_EXCL and 0600, treat EEXIST as re-read rather than overwrite, fstat-and-refuse on every read, and store it base64 with key_id and format version — writeFileSync with a mode option does not change an existing file's mode
- [ ] Encrypt message bodies, asset bytes, command_invocations argv and captured stdout and stderr and truncation marker, status_events progress text, asset display filenames, and the persisted command manifest, each with a distinct AAD domain tag
- [x] encryptRecord(plaintext, aad) generates its own randomBytes(12), with no IV parameter on the public surface; every UPDATE re-encrypts with a fresh IV, and counter or deterministic IVs are prohibited
- [x] AAD is domain, format version, sessionId and rowId over immutable columns only; the 16-byte tag lives in its own BLOB NOT NULL column; assert the IV length is 12 because createCipheriv silently accepts 8, 16 and 32-byte IVs
- [x] Keep ids, sessionId, role, kind and timestamps plaintext so they stay indexable, and document that the exact-length side channel is inherent to GCM and accepted
- [x] messages carries seq INTEGER PRIMARY KEY AUTOINCREMENT as the ordering key because timestamps are neither unique nor monotonic, id TEXT NOT NULL UNIQUE for AAD and idempotent dedupe, plus claim_id, claimed_at and delivered_at
- [x] Store API is exactly claimNext, ack and peekAll implemented as a single UPDATE with RETURNING — deliberately NO atomic pop, so a crash between claim and stdout costs a duplicate rather than a lost human message
- [x] assets carries deleted_at and state so a pruned asset is a known-gone row rather than a missing one
- [x] Hand-roll schema versioning on PRAGMA user_version: one transaction per step with the version bump inside it, BEGIN IMMEDIATE, a re-read of user_version inside the transaction, and close(false) on failure paths
- [x] Migration steps MUST be synchronous — db.transaction with an async body commits before that body finishes
- [x] Forward-only: refuse to open a database whose user_version exceeds the binary's and exit non-zero naming both versions, worded distinctly from a protocol-version mismatch
- [x] Export describeKeySource() for slice 2's status seam rather than editing slice 2's files
- [x] Take a VACUUM INTO snapshot before any multi-statement migration step

#### Testing Criteria
##### Contracts
- [x] Contract: a message written and read back round-trips its body exactly through encrypt and decrypt
- [x] Contract: byte-scan the database file AND its -wal sidecar on disk for the plaintext needle and find nothing — asserting on the column value alone cannot fail
- [x] Contract: plaintext metadata columns remain queryable by sessionId and seq
- [x] Contract: key resolution matches on fingerprint and REFUSES to start on mismatch rather than minting a second key
- [x] Contract: with the keychain reachable, minting writes the key into it; with the keychain unreachable but populated, resolution does not mistake that for absence
- [x] Contract: claimNext under two concurrent readers claims different rows, and an unacked claim is redeliverable
- [x] Contract: command_invocations argv and captured output are ciphertext on disk
- [x] A tampered auth tag fails decryption loudly rather than returning garbage, and a ciphertext moved to another row fails its AAD check
- [x] A fresh database initializes at the current user_version, an older one migrates forward preserving rows, and a newer one is refused
- [x] A migration that throws mid-step leaves user_version at the last completed step
- [x] The state directory is 0700 and the key file is 0600, and an existing key file with the wrong mode is refused
- [x] Key resolution is driven through an injected KeychainBackend seam and DG_KEY_SOURCE of file, keychain or auto — the suite must never read or write the developer's real login keyring

#### Acceptance Criteria
- [x] Given a machine with no reachable keychain, when the daemon starts fresh, then it warns, uses the file key-encryption key, and dg-server status names the file source
- [x] Given a store whose recorded key_id does not match any resolvable key, when the daemon starts, then it refuses and names both the recorded and resolved identities instead of starting with a new key
- [x] Given three messages sent while the agent is not listening, when the agent reads, then it receives all three in seq order
- [x] Given the raw database and -wal files, when scanned with an external tool, then no message body, command argv or captured output appears as plaintext

### Slice 4 — extension-marker-and-background

#### Engineering
- [x] Add utils/chat-marker.ts as its own module for the _chat key, following the one-module-per-marker-key convention and the mirrored-twin rule — do not import the dg-server twin
- [x] Add a content script matched ONLY to http://127.0.0.1/* capturing and stripping the #_chat= marker at document_start
- [x] The content script ONLY parses, strips and relays over lib/chat-messages.ts — chrome.storage.session is not exposed to content scripts and tabs.create is unavailable there, so a naive in-script write throws at runtime
- [x] registerChat in the background performs the storage.session write and the tabs.create, and owns the WebSocket to the daemon so background chats keep receiving while the chat tab is closed
- [x] Add lib/chat-messages.ts as a chat-scoped MSG const object for in-browser IPC, sibling to demo-messages.ts rather than an addition to it
- [x] Wire registerChat through lib/background/index.ts and entrypoints/background.ts
- [x] Route the shared chrome.action.onClicked listener centrally: registerRecording already claims it to start a pending recording or open settings, so preserve pending-recording start first, otherwise open chat, keeping settings reachable separately — two independent listeners would both act
- [x] Add minimum_chrome_version 116 to wxt.config.ts, required for a service-worker-owned WebSocket, and send a keepalive at most every 20s for the socket's whole life
- [x] Add http://127.0.0.1/* to the Firefox branch's host_permissions — Firefox requires matches origins to also be declared there, and that branch currently declares none, while Chrome's all-urls already covers loopback
- [x] Name the chat page URL string once and note the coupling to slice 6, which owns that page
- [x] Give registerChat an injectable options and seams parameter mirroring RegisterProtoOptions

#### Testing Criteria
##### Contracts
- [x] Contract: the _chat marker encodes and decodes a SessionBootstrap, and a malformed payload is rejected rather than partially applied
- [x] Contract: registerChat is exported from lib/background/index.ts and invoked by the background entrypoint
- [x] The content script's manifest match pattern is loopback-only — assert it does not match all-urls
- [x] Capturing a marker relays to the background, which writes storage.session and opens the chat page exactly once
- [x] The marker is stripped from the URL after capture
- [x] Regression: with a pending recording the toolbar action starts it, with none the toolbar action opens chat, and the recording path is not broken by the new listener
- [x] The background keepalive fires at least every 20s while the socket is open
- [x] The Firefox manifest branch includes the loopback host permission, and minimum_chrome_version is set

#### Acceptance Criteria
- [x] Given the daemon's bootstrap URL, when it opens in the browser, then the background captures the session and the marker is gone from the address bar
- [x] Given a page that is not on loopback carrying a lookalike marker, when it loads, then the chat content script does not run
- [x] Given the chat tab is closed, when a message arrives for a live session, then the background still receives it
- [x] bun run --filter='./pkg/extension' test and lint both pass

### Slice 5 — extension-chat-client

#### Engineering
- [x] Add lib/features/chat-client.ts: one WebSocket owned by the background, the sessionId and token pair on every outbound frame, exponential backoff with jitter on reconnect, and createSerialQueue from @dg/common for the outbox
- [x] Demultiplex inbound frames by sessionId across the socket's capability set, dropping frames for sessions not in it rather than misfiling them
- [x] Validate every inbound payload with validateChatFrame before acting; a malformed frame is logged, not thrown past the demux
- [x] Rediscover the daemon on the fixed port and fallback range via GET /health, matching instanceId, when the cached port goes stale
- [x] Add lib/features/chat-sessions.ts holding the live session list, each session's agent identity, unread count, and RUNNING / NEEDS YOU / agent-gone status read from the status frame's explicit state field — never inferred from silence
- [x] Expose markSessionRead(sessionId) rather than inferring read state
- [x] Add lib/features/chat-transcript.ts rendering whole agent messages and folding progress frames into an advancing indicator rather than new transcript entries
- [x] RENDERING CONTRACT: transcript content is untrusted agent and user text and MUST render as plain text via textContent by default, following demo-tour.ts. An innerHTML or Markdown implementation would give transcript content extension-page script privileges including the session token and $ dispatch. If Markdown is wanted, sanitize at the browser boundary and prohibit raw HTML, event handlers and javascript URLs
- [x] Render the command result frame type, and render an attachment by fetching the asset with the session token as a HEADER and displaying the resulting blob URL — never a token in an img query string
- [x] Render a gone asset as an explicit asset-removed placeholder, distinguishable from a load failure
- [x] Emit class-hooked plain DOM only, with zero inline styles and zero positioning — do NOT follow the demo-tour.ts inline-style precedent, which exists for shadow-root overlays on third-party pages
- [x] Request transcript backfill on connect and reconnect via the history frame, so a canvas opened against already-running sessions does not render empty nodes
- [x] Queue messages composed while disconnected and deliver them exactly once on reconnect, deduplicating on the client-generated message id and the daemon's ack
- [x] Expose connection state as an explicit union of connected, reconnecting and daemon-not-running
- [x] Request a new session over the socket so the UI layer can offer a create-chat affordance
- [x] Keep the in-page session object a separate type from the daemon-side handle, per the mirrored-twin rule
- [x] Keep this slice headless beyond the transcript renderer, so slice 6 owns presentation

#### Testing Criteria
##### Contracts
- [x] Contract: every outbound frame carries the correct sessionId and token pair, and inbound frames for sessions outside the capability set are dropped
- [x] Contract: hostile transcript content — script tags, event-handler attributes, javascript URLs and code fences — renders as visible text and executes nothing
- [x] Contract: frames for two live sessions are routed to their own transcripts with no cross-talk
- [x] Contract: connection state transitions through the documented union and never reports connected while the socket is closed
- [x] A dropped socket reconnects with jittered backoff and does not duplicate already-acked messages
- [x] Messages composed while disconnected are delivered exactly once on reconnect, in order
- [x] Progress frames advance the indicator without appending a transcript message
- [x] Status resolves from the frame's explicit state field, including agent-gone
- [x] Backfill on reconnect populates the transcript from the history response
- [x] An attachment renders from a fetched blob URL, and a gone asset renders the removed placeholder

#### Acceptance Criteria
- [x] Given two live sessions on one socket, when both receive messages, then each transcript contains only its own
- [x] Given the daemon is stopped and restarted on a fallback port, when the page stays open, then the client rediscovers it via health and reconnects without a reload
- [x] Given a message typed while disconnected, when the connection returns, then it is delivered exactly once
- [x] Given an agent message containing hostile HTML, when it renders, then no script executes and the markup is visible as text

### Slice 6 — extension-chat-page

#### Engineering
- [ ] Add entrypoints/chat with index.html and main.ts following the entrypoints/review page shape, styled from entrypoints/options/style.css's existing brutalist-neon tokens — no new palette
- [ ] Board root is position fixed, inset 0, overflow hidden, touch-action none — style.css's global body rule constrains every importing page to a 42rem centred column and lives in slice 9's glob, so it cannot be edited here
- [ ] entrypoints/chat/style.css opens with an @reference to ../options/style.css; a second @import of tailwindcss would emit an entire second Tailwind build
- [ ] No shadow root on this page — createShadowRootUi takes a ContentScriptContext and is not callable from an extension page, and a shadow root would make style.css's classes unreachable
- [ ] Add lib/features/chat-node.ts: one node per session showing agent identity, transcript, composer, and a RUNNING / NEEDS YOU / agent-gone badge fed by chat-sessions
- [ ] Ship a plain composer exposing a documented mount seam — one exported hook plus the input element — that slice 8 attaches autocomplete to; the $ and @ manifest does not exist until slice 7 publishes it
- [ ] Lay the page out as the settled grouped rail plus one focused thread, per the Chat page layout verdict — the rail is already linear, so it IS the screen-reader-equivalent view and no second view is needed
- [ ] Section the rail by workset: header with name and slice count, orchestrator row pinned first, agent sessions indented beneath it, and a trailing loose-chats section for sessions with no workset
- [ ] Give the thread pane a workset-and-session breadcrumb
- [ ] Per-node Move control with arrows to nudge, Shift to jump, Enter to commit, Escape to cancel, plus click-to-place — WCAG 2.2 SC 2.5.7 requires a non-drag POINTER alternative, which keyboard support alone does not satisfy
- [ ] Do not use aria-grabbed or aria-dropeffect, both deprecated; announce position changes via a status role
- [ ] Focus model: creation-order traversal with roving tabindex, pan-to-focused-node on focusin, a live region only on the focused node, and a status-role text label on the NEEDS YOU badge
- [ ] Read prefers-reduced-motion through an injectable matchMedia seam and reflect it as a data-motion attribute on the board root, subscribing to change — a CSS-only media query is unobservable under bun test
- [ ] Offer a create-chat affordance that asks the daemon for a new session
- [ ] Offer a close-node control that ends the session via the session-close frame, distinct from any local hide
- [ ] Two zero-states with different copy: no session ever registered, and session known but daemon unreachable
- [ ] Hand-rolled DOM only; reject canvas, WebGL and every node-editor library, all of which require React while this package has two runtime dependencies
- [ ] Do not virtualize or lazy-mount transcripts — plain DOM plus bounded backfill, and profile before optimizing

#### Testing Criteria
##### Contracts
- [x] Contract: the page renders one node per live session and removes a node when its session closes
- [x] Contract: the composer exposes the documented mount seam slice 8 attaches to
- [x] The status badge reflects chat-sessions' state for the right node, including agent-gone
- [x] The create-chat affordance results in a new session node, and the close control emits a session-close frame
- [x] Every node action is reachable by keyboard alone, and repositioning is achievable with a single pointer without dragging
- [x] prefers-reduced-motion flips the data-motion attribute via the injected seam
- [x] The rail renders sections in workset order with the orchestrator first in each, and sessions with no workset fall into the loose-chats section
- [x] Rail and thread content is reachable in document order without a separate view
- [x] Source-text scan over slice 6's own files finds no hard-coded hex colors, and slice 6 imports nothing from ui-helpers.ts
- [x] Both zero-states render with their distinct copy

#### Acceptance Criteria
- [ ] Given several live sessions, when the page loads, then each appears as its own node with its agent identity
- [ ] Given two nodes bound to different agents, when both reply, then the user can read both responses without switching views
- [ ] Given a busy agent, when its turn is in flight, then that node shows RUNNING and switches to NEEDS YOU when it awaits input
- [ ] Given a screen-reader user, when they switch to the linear view, then every node's content and status is conveyed in document order
- [ ] Given a keyboard-only or single-pointer user, when they reposition a node, then no drag gesture is required

### Slice 7 — agent-facing-cli

#### Engineering
- [ ] Transport is a short-lived /cli WebSocket per invocation, with the token read from the session file or DG_SESSION_TOKEN
- [ ] recv --block --timeout has exactly three outcomes: exit 0 delivered, a reserved non-1 exit code for timeout, and 1 for every other failure via the throw-and-exit convention
- [ ] Bound connection establishment by its own short fixed timeout, independent of --timeout, so a dead daemon fails fast instead of hanging for the full block
- [ ] recv claims via the store's lease, decrypts, writes stdout, flushes, and only THEN acks — never an atomic pop, accepting an occasional duplicate over silently dropping a human's typed message
- [ ] Add send for whole agent messages and status for interim progress frames carrying the explicit running or awaiting-input state
- [ ] Add spawn to start an additional background session, optionally bound to a named subagent, invoking slice 2's existing session-create registration rather than a second one
- [ ] Add stage to register an asset for presentation, and close to end a session
- [ ] Accept the command and subagent manifests as JSON file-path arguments matching the proto plant idiom, validated with slice 1's validators and resolved to ABSOLUTE paths in the CLI before sending — the daemon's cwd is whichever repo started it
- [ ] Publish the validated manifest snapshot on registration and on reconnect; there is no change-watcher in this bundle, and an explicit manifest verb replaces any implicit on-change trigger
- [ ] Resolve each entry's argv[0] with Bun.which at publish time and refuse publication of an unresolvable entry or one resolving to a shell or script host — but resolve and spawn again at invocation, since a publish-time check cannot prevent later replacement
- [ ] On zero or multiple cwd matches, error listing live sessions and their cwds and require an explicit --session; never guess. Compare via realpath on both the registration and lookup sides
- [ ] CLI-side daemon plumbing lives in src/commands/client.ts — src/utils/** belongs to slice 2
- [ ] Emit machine-readable output the SKILL.md can instruct the agent to parse, and document every exit code

#### Testing Criteria
##### Contracts
- [ ] Contract: recv --block --timeout returns the documented timeout result and its reserved exit code when nothing arrives, distinct from failure
- [ ] Contract: recv returns a queued message immediately when one is already stored, and acks only after stdout is flushed
- [ ] Contract: an unacked claim is redelivered by the next recv rather than lost
- [ ] Contract: an invalid manifest file is rejected naming the offending entry, and no partial manifest is published
- [ ] Contract: a manifest entry whose argv[0] resolves to a shell or script host is refused at publish
- [ ] Contract: send and status produce frames that validateChatFrame accepts, and status carries the explicit state
- [ ] Manifest paths are resolved to absolute in the CLI before sending
- [ ] --session selects the named session, and zero or multiple cwd matches error and list candidates rather than guessing
- [ ] recv against a dead daemon fails fast with a clear message rather than blocking for the full timeout
- [ ] spawn registers a new session through slice 2's handler and records the agent identity it was given
- [ ] stage registers an asset row, and close emits the session-close frame

#### Acceptance Criteria
- [ ] Given no user message, when the agent runs recv --block --timeout 300, then it returns a timeout result the skill can loop on rather than a failure
- [ ] Given a message sent while the agent was not listening, when recv runs, then it returns that message
- [ ] Given two live sessions in different repos, when the agent runs recv from one, then it receives only that session's messages
- [ ] Given a session closed from the canvas, when the agent is parked in recv, then it returns a distinct closed result

### Slice 8 — command-and-subagent-dispatch

#### Engineering
- [ ] Derive the manifest and cwd strictly from the sessionId the presented TOKEN authenticates, never from a sessionId field the frame carries
- [ ] Execute a $ entry as a typed argv array with whole-element parameter substitution; the daemon never splits a user string and never concatenates user text into an existing argv element
- [ ] Reject any user-supplied argv element beginning with a dash unless the entry opts in, and insert a literal double-dash before user elements where the target supports it — argv arrays make metacharacters literal but do NOT prevent option injection
- [ ] Spawn with detached true and kill the whole process group with TERM then KILL — a child shares the daemon's process group by default, so a negative-pid kill would signal the daemon, and a SIGTERM-trapping child ignores Bun's timeout entirely
- [ ] Pin cwd to the session's registered realpath-resolved cwd, returning a failed result with a distinct reason if it is gone
- [ ] Pass an explicit minimal env allowlist of PATH, HOME, LANG and TZ, plus SystemRoot, USERPROFILE, TEMP and PATHEXT on win32, extensible per entry. Omitting env hands the child the daemon's full environment INCLUDING values Bun's DotEnv loader read from a .env in its cwd
- [ ] Drain both streams in the daemon, counting bytes, stopping at the cap, appending a truncation marker and killing the group — Bun's maxBuffer overshoots by up to 500 times
- [ ] Set stderr to pipe explicitly; the async default is inherit, which sends the failure reason text to the daemon's console instead of the frame
- [ ] Derive the failure reason from signalCode plus the daemon's own knowledge of why it killed; after a kill the exit code reads null while the awaited exit returns 143 or 137. Retain and return partial output captured before a timeout kill
- [ ] Wrap the synchronous Bun.spawn call in try/catch for the missing-binary path and release the invocation row, temp dir and concurrency slot on that throw — Bun.spawn throws ENOENT synchronously
- [ ] Concrete bounds: 30s wall clock, 256 KiB combined stdout and stderr, 2 concurrent per session, 8 daemon-wide, plus a per-session invocations-per-minute ceiling, each overridable per entry but clamped to a daemon maximum, with a distinct failure reason at every bound
- [ ] Return one buffered terminal result frame; chunked or incremental output is deferred to bundle 2
- [ ] Write the command_invocations row before the spawn and update it on completion, recording the exact resolved argv executed as an audit log with the display label kept separate
- [ ] Persist an @ mention as a queued message the next recv claims rather than re-implementing slice 3's queue, and handle the no-reader case
- [ ] An unresolved @ mention passes through as ordinary prose with the resolved-name field absent — never refuse a whole message over a typo
- [ ] Settle and document whether $ and @ must be leading tokens or may appear inline
- [ ] Result frames go out through slice 2's per-socket createSerialQueue
- [ ] Add lib/features/chat-autocomplete.ts attaching to slice 6's documented composer mount seam, offering only manifest entries and rendering the RESOLVED argv on each row so the user sees what will actually run

#### Testing Criteria
##### Contracts
- [x] Contract: a $ entry in the manifest executes and its output returns as a successful terminal result frame
- [x] Contract: a $ entry NOT in the manifest is refused and nothing is executed
- [x] Contract: a user-supplied argument can neither be split into additional argv elements nor be interpreted by the target as an option, with a dash-prefixed input as a named case
- [x] Contract: session A's token cannot dispatch against session B's manifest entry
- [x] Contract: a secret present in the daemon's environment does not appear in captured output
- [x] Source-inspection spec over src/dispatch/** fails on Bun.$, an imported $ from bun, a shell option, sh, bash, /bin/sh, cmd.exe, powershell, or a -c flag
- [x] A SIGTERM-trapping child is still killed at the timeout via the process group
- [x] Output exceeding 256 KiB is truncated with an explicit marker and the group is killed
- [x] A non-zero exit, a timeout and a missing binary each yield a failure frame naming the reason, with partial output retained on the timeout case
- [x] Concurrency and rate bounds each reject with their own distinct reason
- [x] An @ mention with no reader is queued and claimed by the next recv, and an unresolved mention passes through as prose
- [x] Autocomplete offers only manifest entries, renders the resolved argv, supports arrow traversal, accepts on Enter, dismisses on Escape without sending, and exposes a listbox role with aria-activedescendant

#### Acceptance Criteria
- [ ] Given a published command manifest, when the user types $ in the composer, then only manifest commands are offered and each row shows the argv that will run
- [ ] Given the user fires a $ command, when it completes, then the result appears in the transcript and the agent was never invoked
- [ ] Given the user fires an @ mention, when the agent next calls recv, then it receives the mention with the resolved subagent name
- [ ] Given a $ command that traps SIGTERM and runs past its timeout, when the bound expires, then the process group is killed and a failure frame names the timeout

### Slice 9 — asset-staging-and-serving

#### Engineering
- [ ] Stage assets in a session-scoped directory under the resolved ~/.dg root using the per-OS defaults from @dg/common/node
- [ ] The asset GET treats its id as an OPAQUE key looked up in the assets table scoped to the requesting session, using the row's own stored filename — never re-deriving a path from the URL segment
- [ ] Layer proto.ts's ensureSafeAnswerPaths pattern as defense in depth: per-component lstat symlink rejection plus a final realpath containment check
- [ ] Use a copyNoFollow or O_NOFOLLOW-style no-follow open on the staging write, not a bare writeFile
- [ ] Authenticate asset retrieval by session token in a REQUEST HEADER, fetched by extension code and rendered from a blob URL — a token in a query string leaks into logs, Referer and history, and is not forced because extension code can set headers
- [ ] Serve only safe raster content types inline, set X-Content-Type-Options nosniff, and use attachment disposition for everything else — active content served from the daemon origin would otherwise become same-origin script with access to the token and $ dispatch
- [ ] Never accept inline SVG or HTML merely because a content-type lookup recognizes it
- [ ] Decrypt fully, verify the auth tag, and only THEN emit bytes, from an in-memory buffer never written to disk, enforcing the shared max-asset size. Whole-file GCM means a ranged sub-request re-decrypts the whole file
- [ ] Return a distinguishable not-found reason for a pruned or unknown id, distinct from wrong-token and from a containment refusal, using the assets table's deleted_at and state columns
- [ ] Make the daemon authoritative for the asset directory via its own config file — deliberately NOT browser.storage.sync, because a synced filesystem path is meaningless on another host
- [ ] Read and write that setting over AUTHENTICATED WebSocket config get and set frames; a tokenless loopback POST would be CSRF-able by any website the user visits
- [ ] Validate then persist, in that order; on load failure disable the field and show a daemon-not-running hint rather than a stale editable value
- [ ] Reject a configured directory that is not writable at configuration time, naming the reason
- [ ] Clean up a session's staged assets on the session-close transition and prune orphans at startup — two distinct triggers, because slice 2 provides a real close event
- [ ] Hand-rolled fixed extension-to-content-type lookup; no new dependency and no edit to slice 2's package.json
- [ ] Note that slice 9 owns style.css while slice 6 reads it, so a restyle here can regress the chat page

#### Testing Criteria
##### Contracts
- [x] Contract: an asset staged by the agent is retrievable with a valid token header
- [x] Contract: a request without a token, with another session's token, or with the token only in the query string is refused
- [x] Contract: an id containing traversal segments, or resolving through a symlink out of the session directory, is refused
- [x] Contract: an SVG or HTML asset is never served inline, and every response carries the nosniff header
- [x] Contract: the daemon config file is authoritative and a storage.sync value never overrides it
- [x] Contract: the config round trip requires an authenticated frame, and an unauthenticated attempt is refused
- [x] A pruned asset returns a reason distinguishable from unknown-id and from wrong-token
- [x] Per-OS default asset directories resolve to the documented paths (already fully covered, per-OS, by pkg/common/__tests__/node-paths.spec.ts's `resolveDgPaths` assertions — not re-tested here; see config-directory.spec.ts for the new getConfiguredAssetDirectory default-fallback wiring)
- [x] Closing a session removes its staged assets, startup prunes orphans, and the two are separately observable
- [x] An unwritable configured directory is rejected at configuration time with a clear reason
- [x] An asset exceeding the max-asset constant is rejected

#### Acceptance Criteria
- [ ] Given the agent stages an image, when it is presented, then the chat node renders it from a fetched blob URL with no token in any URL and no base64 in the transcript
- [ ] Given a changed asset directory in settings, when the agent stages the next asset, then it lands in the new location
- [ ] Given a closed session, when its assets are requested, then they are gone and the response says so distinguishably
- [ ] Given an HTML file staged as an asset, when it is requested, then it is served as an attachment and never rendered inline

### Slice 10 — distribution-skill-and-ci

#### Engineering
- [ ] Land a stub dg-server-blt.yml as soon as slice 2 exists, path-filtered to pkg/dg-server/** and pkg/common/**, so slices 2 through 9 are gated rather than discovering a broken pipeline at the end; amend it here
- [ ] Add dg-server-release.yml mirroring skills-release.yml's platform matrix and its push filter, which includes pkg/common/**, releasing under a server-v* tag
- [ ] Add plugins/dg/skills/chat/SKILL.md exposing dg:start, documenting the recv, send, status, spawn, stage and close loop, every exit code including the reserved timeout code, and the manifest JSON format
- [ ] The SKILL.md bootstrap gate must test for the dg-server binary, NOT dg-skills — copying the browser skill's gate verbatim short-circuits on any machine that already used browser, demo or proto, so dg-server would never be fetched
- [ ] Generalize the six functions in pkg/skills-cli/src/utils/lib.ts that hardcode dg-skills or the skills tag prefix — cliAssetName, pickCliAsset, resolveCliAsset, fetchCliBinary, cliDest and cliVersionFile — taking binaryName and tagPrefix as two explicit parameters with no derivation rule. versionGte is already binary-agnostic and needs no change
- [ ] Make install refresh all three prebuilt artifacts from GitHub Releases — dg-skills, dg-server and the extension zip — keeping the existing per-binary already-current skip and installCli's warn-and-continue behaviour
- [ ] Verify bootstrap.sh and bootstrap.ps1's existing install tail call already covers dg-server once the fetcher is generalized, BEFORE writing new fetch code — bootstrap.sh's own curl loop hard-exits on a missing asset, so duplicating it would abort the whole bootstrap including the good dg-skills and extension install
- [ ] Extend pkg/skills-test/__tests__/skill-manifests.spec.ts's CLI-invoking block with a dg-server-gated branch — it currently gates on a dg-skills substring, so the chat skill would get zero parity coverage
- [ ] Own the cross-package integration checklist: the browser-plus-daemon criteria no single package's tests can observe, with a browser harness or the documented manual WSL probe, rather than faking depends_on edges that sequence work without making criteria observable
- [ ] Add a manual post-merge step: a repo admin must add the dg-server build check to branch protection, and update docs/DEVELOPER.md's Branch Protection line and CI Overview table
- [ ] Register the chat skill in plugins/dg/skills/README.md's table
- [ ] Document the harness in README.md, docs/DEVELOPER.md and docs/AGENT-INSTALL.md, including the keychain-versus-file-key behaviour, the WSL mirrored-mode requirement, and the four independently versioned artifacts
- [ ] Record in .agents/monolith.md the new vocabulary plus two deliberate departures: dg-server uses a domain-module layout, and its tests directory uses subdirectories
- [ ] Grow docs/AGENT-INSTALL.md's automation matrix and Step 3 help list to mention dg-server and dg:start

#### Testing Criteria
##### Contracts
- [ ] Contract: install resolves and fetches a dg-server asset for the current platform and arch, and skips the download when already current
- [ ] Contract: a platform with no published dg-server asset warns and continues rather than failing the whole install
- [ ] Contract: the generalized fetcher is called once per binary with the right binaryName and tagPrefix, and no fetch logic is duplicated
- [ ] Contract: skill-manifests.spec.ts asserts the chat skill against the dg-server binary path, not dg-skills
- [ ] bootstrap.sh and bootstrap.ps1 place both binaries in the dg bin directory and mark them executable
- [ ] The dg-server workflows' path filters match pkg/dg-server/** and pkg/common/** and do not fire on unrelated changes
- [ ] SKILL.md's documented commands, flags and exit codes match the CLI's actual surface
- [ ] Multi-word prose assertions use a whitespace-tolerant regex, per .agents/school/quality.md

#### Acceptance Criteria
- [ ] Given a clean machine, when install runs, then dg-skills and dg-server are both in the dg bin directory and the extension is staged, all from GitHub Releases with no local build
- [ ] Given dg:start invoked from a plugin install with no source checkout, when the skill bootstraps, then it obtains the prebuilt dg-server binary and opens a working chat window
- [ ] Given a change under pkg/dg-server, when CI runs, then the dg-server build workflow fires and the skills workflow does not
- [ ] Integration: with the daemon running and the extension loaded, a message typed in the chat page reaches a blocked recv, an agent reply renders in its node, a $ command runs without waking the agent, and a staged image renders from a blob URL

### Slice 11 — extension-canvas-surface

#### Engineering
- [ ] Ship the canvas as an OPTIONAL spatial view toggled from the grouped rail, never as the default surface — the rail won the prototype bake-off and is the primary layout
- [ ] Pan and zoom over an unbounded board using one CSS transform on a single board element
- [ ] Export the arithmetic as pure functions over an injected viewport — clampScale, clampPan, screenToBoard, boardToScreen, applyDragDelta and isNodeInView — and drive the spec through those; happy-dom has no layout engine, so no assertion may read a rect
- [ ] Board chrome such as the create-chat button, the daemon banner and zoom controls must be a SIBLING of the transformed board, never a descendant — a transformed or will-change ancestor becomes the containing block for fixed positioning
- [ ] touch-action none, a non-passive wheel listener calling preventDefault, ctrlKey wheel intercepted as pinch, and a wheel over a transcript scrolling that transcript without zooming the board
- [ ] will-change transform only during an active gesture, and one requestAnimationFrame write per frame
- [ ] Persist node positions in chrome.storage.local keyed by session id, pruned on load against the live session list
- [ ] Honour the board root's reduced-motion attribute for pan and zoom easing

#### Testing Criteria
##### Contracts
- [x] Contract: clampScale and clampPan keep the viewport within documented bounds for representative inputs
- [x] Contract: screenToBoard and boardToScreen round-trip a point
- [x] Node positions persist per session and are restored on a page reload within one daemon lifetime, and orphan keys are pruned on load
- [x] A wheel event over a transcript scrolls it and does not change board scale
- [x] A ctrlKey wheel is treated as zoom and calls preventDefault
- [x] The reduced-motion attribute suppresses easing
- [x] Board chrome is not a descendant of the transformed element
- [x] isNodeInView reports a node dragged outside the viewport, which the page's pan-to-focused-node uses to recover it

#### Acceptance Criteria
- [ ] Given several nodes, when the canvas loads, then each appears in its saved position
- [ ] Given a node moved off-view, when it receives focus, then the board pans to it
- [ ] Given the accepted prototype verdict, when the built canvas is compared against its recorded description, then the layout and theme match
- [ ] Given prefers-reduced-motion, when the user pans or zooms, then no easing animation plays

## Slice Summaries

### Slice 1 — shared-contracts

Landed the shared wire-format and path contracts every later slice imports. `chat-format.ts` carries the 17-discriminant `ChatFrame` union with a hand-rolled `validateChatFrame` in the existing `validateVerdict` idiom, plus `authorizeFrame` as a separate capability-set check so shape validation and authorization never collapse into one call that can silently authorize. `assert.ts` now owns `fail`/`isRecord`/`requireX`, shared with `proto-format.ts`. `SessionBootstrap` and `DaemonHandle` are distinct types and the lockfile shape cannot hold a token. `@dg/common/node` is a new subpath export kept out of the `.` barrel, carrying `resolveDgPaths` and the `isWSL`/`run`/`tryOpen`/`openers` helpers hoisted out of `pkg/skills-cli` plus the new `runCapture`.

Took four passes: three stopped at RED because the plan pinned behavior in detail but identifiers barely at all, so each pass invented names and reported them as `[SPEC]` deferrals. Eleven contract decisions are now recorded in `## Code Structure`'s ratifications subsection, which is where slices 2, 5, 6, 8 and 9 should read their identifiers from. The last pass also caught a real design hole: `session-close` and `session-closed` had been collapsed into one bidirectional discriminant, which would have either broken slice 6's close control or allowed a socket holding session A's capability to close session B. Split and covered by tests.

Verified: `pkg/common` 107 pass / 0 fail, `pkg/skills-cli` 96 pass / 0 fail, both `tsc --noEmit` clean, and `pkg/extension` builds with no `node:` polyfill.

### Slice 2 — dg-server-skeleton

One 127.0.0.1 HTTP+WebSocket daemon hosting many sessions, compiled to a `dg-server` binary. 28
source modules across `server/`, `session/` and `utils/`, plus the `verify-wsl-loopback.ts` evidence
probe. Authorization is a per-socket capability set: a socket accumulates `sessionId -> token` only
via a captured bootstrap or an authenticated session-create, and every inbound frame is checked
against the exact pair, so a socket holding session A cannot act on session B.

QA found four things worth naming. `start` never actually exercised the WSL NAT refusal where it
reaches the user — a mutation test (commenting out `checkWslNetworking()` in `cmdStart`) left the
suite fully green, because the identical call in the detached `__serve` child has stdio ignored and
surfaces only as a generic 15s timeout. The refusal was also dead for default WSL2: a missing
`.wslconfig` read as `unknown` and was treated as permissive, but NAT *is* the default and
`.wslconfig` is opt-in. `POST /start` had no Origin check at all despite minting a live capability —
verified against the running daemon, `Origin: https://evil.example` returned a 200 and a fresh
token. And the connect handshake sent nothing back, so a page connecting after sessions already
existed could not learn of them and had no way to ask, since `session-list` is outbound-only.

Verified: 47 pass / 1 todo / 0 fail, lint clean, binary compiles, `bun install --frozen-lockfile`
succeeds. Two items stay deferred by ratification: the idle-TTL "blocking recv parked" assertion
waits on slice 7's `recv --block`, and the WSL-mirrored acceptance criterion needs the hardware pair
no CI runner can host.

### Slice 4 — extension-marker-and-background

A content script matched only to `http://127.0.0.1/*` parses and strips the `#_chat=` marker and
relays it; the background does the `storage.session` write and the tab open and owns the WebSocket,
so background chats keep receiving while the chat tab is closed. `registerChat` now owns the single
`chrome.action.onClicked` listener and `registerRecording` no longer registers its own, with
pending-recording start still winning so the recorder path is unchanged.

QA caught a Firefox crash that had shipped green through test, lint and build: the default
`browserApi` seam read `browser.action`, but WXT emits firefox-mv2 where `action` is undefined
(`browser_action` instead, and `action` is MV3-only). Every test injected the seam, so the
production default path was never exercised. Fixed, with a test that drives the default resolution
against an MV2-shaped global.

Verified: `pkg/extension` 397 pass / 0 fail, lint clean, build succeeds.

### Slice 7 — agent-facing-cli

Built by an external `codex` backend against tests written first; it changed no tests. The verbs
speak a `cli-*` family over `/cli`, outside the 18 ratified discriminants and checked structurally
before `validateChatFrame` — the same carve-out `connect` uses, and necessary because the outbound
frames it maps onto have no token field. `recv` has three distinct exit codes, and
`handleUserMessage` now persists, without which the whole path was inert.

QA found two security holes, both traceable to ratification wording rather than the implementation:
manifest validation ran only in the CLI wrapper, so a raw `/cli` socket could publish
`argv:["bash","-c","{cmd}"]` with no error at all; and `CHAT_MAX_MANIFEST_BYTES` was likewise
client-side, admitting a 123KB manifest against a 64KB cap. Both now enforce in the daemon handler.
It also found that the `it.todo` this slice was tasked with promoting was **vacuous** — it never
closed the auto-registered session, so the session count kept the daemon alive rather than the parked
connection, and deleting the connection check from `isIdle()` left the test green. Fixed and
re-verified by mutation.

Verified: `pkg/dg-server` 140 pass / 0 fail / 0 todo, `@dg/common` 108 pass, lint clean, binary
compiles.

### Slice 6 — extension-chat-page

Built by `codex` against tests written first; it changed no tests and kept the one-socket invariant —
the built page chunk contains zero `WebSocket` references while the background holds the single
socket, which is the check that verifies it (identifier greps are useless here, since the production
build minifies and mangles local names).

QA returned 24 findings. The two worst were state, not appearance. `syncPage()` called
`replaceChildren()` on every inbound frame, and detaching a focused element drops focus to `body` —
so the caret was yanked out of the composer on every progress frame, and arrow-key reorder died after
one press with move mode armed and no keyboard exit. And the page kept a *second* capability set
seeded only from `storage.session`, which is in-memory: restarting the browser while the daemon held
a live session left the rail empty with no recovery path, since the page could only gain a capability
from a stored bootstrap or a `session-pending` it requested itself. Also fixed: errors rendered into
a 1px screen-reader-only node; a user message was appended before its send was accepted; the theme
toggle left accent text at 1.15:1 because the inversion blocks remapped five tokens but neither
accent.

Verified: `pkg/extension` 503 pass / 0 fail, lint clean, build clean.

## Agent Notes

- (slice 6, js) `pkg/extension/entrypoints/options/style.css` gained four OS-invariant accent token aliases — a boundary crossing into **slice 9's** file. They restate hex values already in that file (no new palette) and had to live outside the `prefers-color-scheme` gate so the chat page's inversion blocks can reach the forced theme's accents. Slice 9 should keep them.
- (slice 6, js) `createRelayChatClient` carries a local `sendUserMessageAndWait` beyond the ratified `ChatClient` interface, feature-detected by `main.ts` so injected fakes fall back to the shared contract. It exists so a rejected send is distinguishable from an accepted one without widening a cross-consumer type.
- (slice 6, js) `ChatBrowserApi.runtime.sendMessage` is now REQUIRED rather than optional. Real Chrome MV3 and Firefox both always have it, and optional meant the relay's outbound half could silently no-op — the same shape of gap that shipped slice 4's Firefox crash.
- (any slice) Never build a dedupe or cache key by concatenating untrusted text around a control character. `chat-transcript.ts` used a literal NUL, which made git treat the whole file as BINARY (`Bin 7288 -> 7719 bytes`, zero insertions) — unreviewable in a diff — and was a latent collision risk since a body can contain a NUL. Length-prefix instead (`role:len:body`).
- (slice 3, js) Wiring a `ChatStore.open()`-style call into the daemon's real startup path makes EVERY subprocess-driven test inherit its key-resolution defaults — including tests unrelated to crypto. Force `DG_KEY_SOURCE=file` at the shared subprocess-env harness, not per test file, or `auto` mode will probe and WRITE to the developer's real OS keychain during ordinary runs.
- (slice 3, js) `PRAGMA foreign_keys` and `busy_timeout` are per-CONNECTION and reset to 0 on any fresh `Database` instance; only `journal_mode` persists in the DB header. A test asserting them through a separate raw connection can never pass for any implementation — drive the real setup function against that connection instead.
- (slice 3, js) Read a key file by `fstatSync(fd)` after `openSync`, never `statSync(path)` then open separately — the path-based check has a TOCTOU race where the file can be swapped between check and read.
- (slice 5, js) To verify a module is actually SHIPPED, grep the built bundle for wire-protocol string literals, not identifier names: `bun run build` minifies and mangles every local name, so a correct delegation greps to zero hits by function name.
- (slice 5, js) This repo's comment-length hook re-checks a whole `/** */` block whenever an edit touches it, not just the diff. Several pre-existing spec-file headers run past the cap and were never re-triggered; the moment you edit one you must shrink it in the same edit or the write is blocked.
- (slice 2, js) `/cli` authenticates with the `X-Dg-Session-Id` and `X-Dg-Session-Token` request headers; `/ws` with a `{type:"connect",...}` frame after open. Slice 7 must use those exact header names.
- (slice 2, js) The dev box runs genuine WSL2 with `WSL_DISTRO_NAME` set and `.wslconfig` at `networkingMode=mirrored`, so `isWSL()` is true and the real probe path runs here. The NAT-branch test forces `WSL_DISTRO_NAME` in a subprocess env rather than depending on that ambient state.
- (slice 4, js) An agent researching the pre-monorepo `action`/`browserAction` split checked out historical `extension-src/` copies, which left stale unmerged index entries that block `git commit` repo-wide. If a commit fails with unmerged paths, check `git ls-files -u` for artifacts like this before assuming a real conflict.
- (slice 1, qa-writer) Cross-platform path-resolver tests should derive expected paths through `node:path`'s `win32`/`posix` submodules rather than hardcoding separator literals — that keeps exact-equality assertions valid for an injected `platform` seam regardless of the CI host OS.

- (slice 1, js) `pkg/common/src/node/process.ts` holds `isWSL`/`openers`/`tryOpen`/`run` hoisted verbatim, plus the new `runCapture(cmd, args, {stdin})` that never throws and keeps stdout and stderr separate — that separation is what slice 3's keychain backend needs. `pkg/skills-cli/src/utils/lib.ts` re-exports them for backward compatibility, but every direct call site in `pkg/skills-cli` now imports straight from `@dg/common/node`.
- (slice 1, js) **`runCapture` rejects for a nonexistent binary** rather than resolving `{status,...}` — confirmed empirically. A caller probing for an optional CLI (slice 3's keychain probe) must `try/catch`; branching on `.status` alone misses the missing-binary case.
- (slice 1, js) `authorizeFrame`'s parameter is a minimal structural `{ type: string; sessionId: string }` rather than `ChatFrame`. `ChatFrame` stays assignable to it, so callers are unaffected.
- (slice 1, qa-writer) Frame-builder test helpers need `as const` on the `type:` literal when they spread a `Record<string, unknown>` overrides parameter after it — without it `tsc --noEmit` fails on structural widening even though `bun:test` runs fine. The fix belongs in the test literals, not in production types.

## Issues Remediation

## Code Structure

Decisions from the structure grill (step 1.5) plus the step-6 escalation pass. Each crosses a
slice boundary and would cost rework if two engineers guessed differently. Slice engineers build
against these; per-slice reviews check them.

### Chat frame protocol
- **Decision:** A `ChatFrame` discriminated union keyed on `type` with a hand-rolled `validateChatFrame`, following the existing `Verdict` / `validateVerdict` idiom — no schema library. `fail`/`isRecord`/`requireX` are extracted to `assert.ts` and shared with `proto-format.ts`.
- **Home:** `pkg/common/src/chat-format.ts`, `pkg/common/src/assert.ts`
- **Rationale:** The repo has exactly one validated-wire-format convention, and both the daemon and the extension already import `@dg/common`.
- **Alternatives:** Ad-hoc untyped frames — drops the repo's only validated-wire-format convention; reusing `MSG` — that is a same-origin IPC key set, not a wire schema.
- **Applies to:** slices 1, 2, 5, 6, 7, 8, 9, 11

### Authorization: capability sets, not a bearer token per frame
- **Decision:** An authenticated socket accumulates a `sessionId → token` capability set, gaining entries only via a newly captured bootstrap or an authenticated session-create response. Every **inbound** frame is validated against the exact pair; **outbound** frames carry `sessionId` only and never a token. Dispatch and send derive the manifest and cwd from the sessionId the token authenticates, never from a frame field.
- **Home:** `pkg/common/src/chat-format.ts` (shape), `pkg/dg-server/src/server/**` (enforcement)
- **Rationale:** Echoing a credential on server-to-page traffic leaks it without authenticating anything, and "any valid token unlocks the daemon" would let a scratch repo's token fire another repo's manifest entry in that repo's working tree.
- **Alternatives:** Token on every frame in both directions — leakage with no authentication benefit; strictly per-session tokens — the canvas then needs an undeclared mechanism to see other sessions.
- **Applies to:** slices 1, 2, 5, 6, 8, 9

### Session handle: two types, not one
- **Decision:** `DaemonHandle` (pid, port, instanceId, versions) for the singleton lockfile, and `SessionBootstrap` (port, sessionId, token, agentIdentity) for the marker. **The lockfile never contains a session token.** The in-page session object stays a separate mirrored twin.
- **Home:** `pkg/common/src/chat-format.ts`; in-page twin in `pkg/extension/lib/features/chat-sessions.ts`
- **Rationale:** Cardinality and secrecy differ — one daemon, many sessions — and one lockfile cannot represent many handles. The twin rule preserves the build-root isolation `marker.ts`/`demo-marker.ts`/`proto-marker.ts` already maintain.
- **Alternatives:** One universal handle — puts bearer tokens in a file that exists to describe the daemon, and breaks the existing twin isolation.
- **Applies to:** slices 1, 2, 4, 5, 6

### `~/.dg` path resolver and root override
- **Decision:** A Node-only path module exposed as a `./node` subpath export of `@dg/common`, kept out of the `.` barrel. Named fields (`lockfilePath`, `dbPath`, `keyPath`, `assetsDir`, `sessionsDir`, `logPath`) plus a **0700** state directory. **`DG_HOME` is the only root override; `AI_SCRATCH_DIR` must not affect it.**
- **Home:** `pkg/common/src/node/paths.ts`
- **Rationale:** The extension bundles the `.` barrel through a Vite alias and has no `node:` builtins. `AI_SCRATCH_DIR` defaults to a reboot-cleaned path and is env-dependent, so honouring it here would wipe the store and key on reboot and split-brain the lockfile between shells during normal operation.
- **Alternatives:** Private module in `pkg/dg-server` — a third `~/.dg` definition that will drift; extend `proto-paths.ts` — inverts the dependency onto the CLI's private utils.
- **Applies to:** slices 1, 2, 3, 9

### Transcript rendering contract
- **Decision:** Transcript content is **untrusted** and renders as plain text via `textContent` by default, emitting class-hooked DOM with no inline styles. Markdown, if ever added, is sanitized at the browser boundary with raw HTML, event handlers, and `javascript:` URLs prohibited.
- **Home:** `pkg/extension/lib/features/chat-transcript.ts`
- **Rationale:** An `innerHTML` implementation would give agent- and user-authored text extension-page script privileges — including the session token and `$` dispatch. `demo-tour.ts` already uses `textContent` for authored prose.
- **Alternatives:** Markdown with `innerHTML` — converts every message into a script-injection vector on the page that holds the credential.
- **Applies to:** slices 5, 6

### Composer mount seam
- **Decision:** Slice 6 ships a plain composer exposing one documented exported hook plus the input element; slice 8's autocomplete attaches to it, and slice 5's transcript renderer owns `command result` and attachment rendering.
- **Home:** `pkg/extension/lib/features/chat-node.ts` (seam), `chat-autocomplete.ts` (consumer), `chat-transcript.ts` (results)
- **Rationale:** The manifest does not exist until slice 7 publishes it, so slice 6 cannot wire the affordances — and slice 8's file list holds no composer, socket, or renderer. This keeps every file list disjoint and puts frame rendering with the other frame rendering.
- **Alternatives:** Add `chat-node.ts` and `chat-transcript.ts` to slice 8's files — creates a three-way overlap.
- **Applies to:** slices 5, 6, 8

### Asset retrieval and content typing
- **Decision:** The asset id is an **opaque key** looked up in the `assets` table scoped to the requesting session. Retrieval authenticates by session token in a **request header**, fetched by extension code and rendered from a blob URL. Only safe raster types serve inline, always with `X-Content-Type-Options: nosniff`; everything else is attachment disposition.
- **Home:** `pkg/dg-server/src/assets/**`, `pkg/extension/lib/features/chat-transcript.ts`
- **Rationale:** A query-string token leaks into logs, `Referer`, and history — and it is not forced, because extension code can set headers where an `<img src>` cannot. Active content served from the daemon origin would otherwise become same-origin script with access to the token and `$` dispatch.
- **Alternatives:** Token in the URL — leaks a command-capable credential; path-derived ids — reintroduces traversal; inline SVG — same-origin script by another name.
- **Applies to:** slices 3, 5, 9

### Daemon config transport
- **Decision:** The asset directory is daemon-authoritative in the daemon's own config file, read and written over **authenticated WebSocket config get/set frames**.
- **Home:** `pkg/dg-server/src/assets/**`, `pkg/extension/entrypoints/options/**`
- **Rationale:** `storage.sync` replicates across machines and a filesystem path valid on one host is meaningless on another. A tokenless loopback POST would be CSRF-able by any website the user visits; reusing the socket means one auth path and one validator.
- **Alternatives:** `storage.sync` authoritative — syncs a WSL path to a Mac; a JSON HTTP endpoint — a second auth path and a second place the Host/Origin checks must be right.
- **Applies to:** slices 1, 6, 9

### Result convention
- **Decision:** Two conventions, matching the two transports. Daemon-to-page frames carry an `{ok, error}` envelope; the agent-facing CLI throws and exits non-zero — **with an explicit carve-out** for `recv`'s reserved third outcome, a distinct non-1 exit code for timeout.
- **Home:** `pkg/common/src/chat-format.ts` (frames), `pkg/dg-server/src/index.ts` (typed error carrying its own exit code)
- **Rationale:** Both conventions already exist in the repo for exactly these two situations. A blanket `exit(1)` would forecloses the timeout code the skill's loop depends on.
- **Alternatives:** One convention for both — either loses CLI exit-code semantics or wraps every frame in an exception path that cannot cross a socket.
- **Applies to:** slices 2, 5, 7, 8, 9

### Outbound frame ordering
- **Decision:** One `createSerialQueue` from `@dg/common` **per socket**, awaiting `ServerWebSocket` drain. No new queue primitive, and no daemon-wide instance.
- **Home:** `pkg/common/src/serial-queue.ts` (existing)
- **Rationale:** It is already written for MV3 service-worker suspension and no competing primitive exists. A daemon-wide instance would head-of-line-block every session behind one slow socket.
- **Alternatives:** A local promise chain per module — duplicates a shared utility; one daemon-wide queue — couples unrelated sessions.
- **Applies to:** slices 2, 5, 8

### Marker module and capture scope
- **Decision:** `_chat` gets its own marker module, captured by a content script matched **only** to `http://127.0.0.1/*`. The script only parses, strips, and relays; the background performs the `storage.session` write and the tab open, and owns the WebSocket.
- **Home:** `pkg/extension/utils/chat-marker.ts`, `entrypoints/chat-marker-capture.content.ts`, `lib/background/chat.ts`
- **Rationale:** The chat marker only ever appears on the daemon's own bootstrap page, so it needs far narrower reach than demo/proto. `chrome.storage.session` is not exposed to content scripts and `tabs.create` is unavailable there, so the naive in-script write throws at runtime.
- **Alternatives:** A `_chat` branch in the existing `<all_urls>` script — makes session tokens parseable on every page and does work on every navigation.
- **Applies to:** slices 4, 6

### Chat page layout verdict — grouped rail
- **Decision:** Settled by `/prototype`, variant **A** of the workset round (`.agents/prototype/chat_harness_canvas/`, replay with `prototype-ui .../variants.md`). **Prose, because `.gitignore` keeps `.agents/prototype/` untracked and no other checkout or CI run can open the artifact:** one left rail plus one focused thread. The rail is sectioned by **workset**; each section header carries the workset name and slice count, the **orchestrator** row is pinned first, and its assigned agent sessions are indented beneath it. A trailing "loose chats" section holds ad-hoc sessions belonging to no workset. Everything is visible at once — no drill-down and no second navigation level. The thread pane carries a `<workset> / <session>` breadcrumb. Dark is the default, light is a toggle, and every colour comes from the existing theme tokens.
- **Home:** `pkg/extension/entrypoints/chat/`, `pkg/extension/lib/features/chat-node.ts`
- **Rationale:** Beat an infinite pan/zoom canvas, an auto-tiling grid, and a column-per-agent board in a three-round bake-off. The rail keeps every live session and its status legible at once, which is what comparing two agents actually needs, and it is linear by construction — so it satisfies the screen-reader equivalence requirement without a second view to keep in sync.
- **Alternatives:** Pan/zoom canvas as primary — spatial meaning no screen reader can render, and it lost the bake-off; three-column workset strip — an extra navigation level for a session count that does not need one; flat rail with a tab bar over the thread — hides which workset a session belongs to until you look at the tab strip.
- **Applies to:** slices 1, 2, 6, 11

### Worksets
- **Decision:** A session carries an optional `workset` label and a `role` of `orchestrator` or `agent`. The daemon stores and echoes both without interpreting them; the page does all grouping.
- **Home:** `pkg/common/src/chat-format.ts` (fields), `pkg/dg-server/src/session/**` (storage), `pkg/extension/lib/features/chat-sessions.ts` (grouping)
- **Rationale:** The rail layout needs grouping and a pinned orchestrator, and two nullable fields buy exactly that. Keeping the daemon uninterpreting means no coupling to the `/spec` bundle format lands in bundle 1.
- **Alternatives:** Deriving worksets from `/spec` bundles — couples the daemon to that format and adds real slices; a full orchestrator that routes work to member sessions — an agent-supervision feature larger than the rest of the bundle, and overlapping bundle 2.
- **Applies to:** slices 1, 2, 6

### Slice-1 contract ratifications (execute-mode, layer 0)

Pinned when slice 1's RED stage reported them as `[SPEC]` deferrals. Three were settled by the user; the rest against existing repo convention or a plain reading of
spec bullets the enumerated lists had missed.
These are binding on every slice that imports `@dg/common`.

- **Frame discriminants are kebab-case**, and there are **17** of them. The Engineering checklist enumerates 14 concepts; `ack` is a 15th that the “client-generated message id … plus an ack frame” bullet requires and the enumeration omitted; and both `session create` and `session closed` expand into a request/broadcast pair (see the next bullet and the close-split bullet below), which makes 17. The full set, verbatim: `user-message`, `ack`, `agent-message`, `progress`, `command-invocation`, `command-result`, `manifest-publish`, `session-list`, `session-create`, `session-pending`, `session-close`, `session-closed`, `history-request`, `history-response`, `config-get`, `config-set`, `error`. Tests should enumerate this set rather than assert a total as a magic number.
- **The `progress/status` bullet offers two words for one concept; the discriminant is `progress`.** Purpose and Scope both call these “progress frames”, so the spec’s own prose settles it. It carries the ratified `state: running | awaiting-input | agent-gone` field.
- **Session creation is two discriminants, not one:** `session-create` (inbound request, authenticated with the REQUESTING session's pair) and **`session-pending`** (outbound response, carrying the new session's id and token in a nested field). Two types let the validator enforce "outbound frames never carry a token" structurally per type, with `session-pending` as the single declared carve-out; one shared discriminant would force the validator to infer direction, which it cannot do.
- **Authorization is a separate export:** `authorizeFrame(frame, capabilities)`. `validateChatFrame(value)` stays pure shape validation, matching the `validateVerdict` / `validateProtoPlan` idiom. Not an optional second parameter — an omitted capability set would silently authorize every frame, and slice 2's enforcement layer is the one place that must never do that.
- **`workset` and `role` live on a distinct `SessionSummary`** (the session-list entry type), and the `session-create` frame sets them. **`SessionBootstrap` keeps exactly its four ratified fields** (port, sessionId, token, agentIdentity). The rail needs grouping for every live session, which it learns from the session list — the marker describes only the one session being bootstrapped, so it never needs these fields.
- **Size-limit constants use the `CHAT_MAX_*` prefix** (e.g. `CHAT_MAX_PAYLOAD_BYTES`), mirroring `PROTO_MAX_VARIATIONS` / `PROTO_MAX_MARKUP_CHARS` in `proto-format.ts`.
- **The path resolver is `resolveDgPaths(seams: SystemSeams = {})`**, mirroring `resolveDownloadsDir` in `pkg/skills-cli/src/utils/proto-paths.ts` — same `SystemSeams` injection shape for `platform`, `homeDir` and `env`.
- **It returns seven fields:** the six named in the `~/.dg` decision above plus **`stateDir`**, the 0700 directory that decision calls for.
- **`DG_HOME` replaces `<home>/.dg` wholesale** — `DG_HOME=/custom/root` yields `stateDir=/custom/root`, not `/custom/root/.dg`. This mirrors how `protoScratchPath` already treats `AI_SCRATCH_DIR` (`join(AI_SCRATCH_DIR, "proto")` replacing `join(homeDir, ".dg", "proto")`). `AI_SCRATCH_DIR` still must not affect this root.
- **`session-close` and `session-closed` are two discriminants, not one** — a correction to this
  subsection's own first draft, which counted 16 by collapsing them. `session-close` is the
  **inbound** close request and carries the `sessionId`+`token` pair; `session-closed` is the
  **outbound** broadcast and carries no token. The spec already made this distinction and the
  first draft missed it: slices 6, 7 and 9 all name the `session-close` frame, while slice 1's
  enumeration names the `session closed` broadcast.
  **Why it must be split rather than given an optional token:** the `/ws` page socket holds
  capabilities for MANY sessions, and slice 2 lists the canvas as one of three legitimate
  closers. With one bidirectional discriminant, either the validator rejects every
  page-originated close — silently breaking slice 6's close control — or `authorizeFrame` is
  skipped for it, letting a socket holding only session A's capability close session B by naming
  it, invalidating B's token, releasing B's parked `recv` and triggering B's asset cleanup. That
  is exactly the cross-session escalation the capability model exists to prevent. Splitting keeps
  "outbound frames never carry a token" enforceable per type, the same reason
  `session-create`/`session-pending` are split.

### Transport and naming ratifications (execute-mode, layer 1)

Slices 2 and 4 each stopped at RED on the same class of gap: the plan pins behavior but not wire
encodings, seam shapes or identifier strings. Settled here once, against existing repo convention,
so slices 5-11 read them rather than re-deriving them. Binding on every slice.

- **Marker payload is `base64url(JSON)` in the URL fragment**, no compression. `utils/demo-marker.ts` already does exactly this (`#…_demo=<base64url(json)>`, `&`-separated `k=v` parts), and `SessionBootstrap` is four short fields — `proto-marker.ts`'s gzip exists only for `ProtoPlan`'s markup payload. Slices 2 and 4 arrived at this independently; it is now the contract for both twins.
- **Capability capture is a post-connect handshake frame on `/ws`, and a request header on `/cli`.** NOT a query string on either. A browser `WebSocket` cannot set request headers at all, so `/ws` has no header option; and the asset-retrieval decision above already ruled that a query-string token "leaks into logs, `Referer`, and history" — the daemon's own size-capped `~/.dg/dg-server.log` is one of those logs. The `connect` handshake the frame-protocol decision calls for is the natural carrier. Bun's `WebSocket` client *can* set headers (verified empirically, see `## Agent Notes`), which is what makes the `/cli` half workable.
- **`GET /health`'s `daemon` field is the service-name string `"dg-server"`**, not a boolean. Its stated job is rediscovery, which needs an identity to match on.
- **The hidden daemonizing subcommand is `__serve`** — slice 2's own Engineering bullet names it in prose ("start re-execs … on a hidden `__serve` subcommand"). Not open.
- **Slice 2 may add the default-port and fallback-range constants to `pkg/common`** despite `pkg/common/**` being absent from its file list — the Engineering bullet requires them to be `@dg/common` constants, and that beats the file-list omission. They belong beside `CHAT_MAX_*`. Safe in this layer because slice 4, its only parallel sibling, must not touch `pkg/common`.
- **Test seams follow the `DG_`-prefixed env convention** that `DG_HOME` and `DG_PORT` establish. Slice 2 adds **`DG_IDLE_TTL_MS`** so the idle-TTL contract is testable in bounded CI time, and an injectable **WSL networking-mode seam** mirroring `SystemSeams`, because ambient `.wslconfig` state cannot exercise the NAT-mode refusal branch on a mirrored-mode box.
- **In-browser IPC message values are `"dg-chat:<kebab-verb>"` strings**, mirroring `demo-messages.ts`'s `"dg-demo:<kebab-verb>"`. The captured-bootstrap relay is `MSG.markerCaptured` carrying `{ type, bootstrap }`.
- **`RegisterChatOptions` is all-optional with `DEFAULT_*` consts for the numbers**, mirroring `RegisterProtoOptions = { previewDownloadTimeoutMs?, browserApi? }`. Fields: `browserApi?`, `openSocket?`, `keepaliveIntervalMs?`, `maybeStartRecording?`.
- **`registerChat` owns the single `chrome.action.onClicked` listener**, and `lib/background/recording.ts`'s own registration is REMOVED rather than left alongside it. Two listeners would both fire, which is the regression slice 4's Testing Criteria guards. Pending-recording start wins; otherwise open chat; settings stays reachable separately.
- **Deferred to slice 7, not dropped:** the idle-TTL contract's "nor while a blocking recv is parked" half cannot be asserted until slice 7 ships `recv --block`. It stays an `it.todo` in `pkg/dg-server/__tests__/session/idle-ttl.spec.ts` and slice 7 must promote it.

### Layer-1 QA corrections (execute-mode)

Contract-level consequences of layer 1's QA findings. The rest of those findings are ordinary bugs
fixed in place; these three change what later slices build against.

- **An 18th discriminant, `keepalive`** — inbound, carries the `sessionId`+`token` pair, and the daemon notes activity and replies with **nothing**. Slice 4's keepalive was a `config-get` with `key: "keepalive"`, which slice 2 answers with "config transport is not implemented yet (lands in slice 9)" — so every session emitted one unsolicited `error` frame every 20s for the life of the socket, and slice 5 owns the connection-state UI that would have to explain them. A browser `WebSocket` cannot send protocol-level pings, so an application frame is required; overloading config transport for liveness is not it. Replying with nothing avoids doubling the traffic this exists to minimise.
- **The page learns the session list on connect.** `handleConnectHandshake` must send a `session-list` built from the registry immediately after granting the capability. Pushing it only from the registry's "changed" listener means a page connecting after the sessions already exist sees none of them, and `session-list` is outbound-only so the page cannot ask. Without this the grouped-rail verdict is unreachable for slices 6 and 11.
- **`POST /start` gets the same Origin check as `/ws`, `/cli` and `/health`.** It mints and returns a live session capability, and today it is the one route with no Origin check at all — verified against the running daemon, `Origin: https://evil.example` gets a 200 with a fresh sessionId and token. Its CSRF defense currently rests entirely on a browser declining to send that cross-origin POST, which is an implicit guarantee for the most sensitive route in the daemon.
- **Deferred to slice 7, not dropped:** `readSessionToken` and the `DG_SESSION_TOKEN` override in `pkg/dg-server/src/session/tokens.ts` have no callers and no tests yet. Slice 7 is their consumer and must prove the override wins over the on-disk file, and that the JSON shape it parses matches what `writeSessionToken` emits.

### Layer-1 wire details as built (execute-mode)

What slice 2 actually implemented, recorded so slices 5, 6, 7 and 9 build against the real strings
rather than re-deriving them. These are observations of committed code, not open decisions.

- **`/ws` capability capture** is a `{ type: "connect", sessionId, token, protocolVersion }` frame sent after the socket opens. `connect` sits deliberately OUTSIDE the 18 ratified `ChatFrame` types — all of those assume a capability already exists — and is checked structurally, not through `validateChatFrame`. It is one of the two pre-capability carve-outs slice 1's Engineering calls for.
- **The daemon answers a successful handshake with a `session-list`** built from the registry, on that socket. A protocol-version mismatch or an invalid/closed capability gets an `error` frame instead and counts against the socket's failed-frame budget.
- **`/cli` capability capture** is via request headers `X-Dg-Session-Id` and `X-Dg-Session-Token` on the upgrade. Slice 7 must use these exact names.
- **`keepalive` draws no reply at all** — the daemon calls `noteActivity()` and returns. Slice 5's connection-state logic must not wait on a response to it.
- **`history-request` currently answers `history-response` with an empty `messages` array**, a faithful pre-persistence placeholder until slice 3 wires the store. Slice 5's backfill-on-reconnect will read empty until then; that is expected, not a bug to work around.
- **`command-invocation` and `config-get`/`config-set` answer with an explicit "not implemented yet" `error` frame** naming slice 8 and slice 9 respectively. Slice 5's connection-state UI should not treat those as connection faults.

### Layer-2 module surface ratifications (execute-mode)

Slices 3 and 5 both stopped at RED asking for the same thing: the plan pins their behavior in
detail and names almost none of their identifiers. Settled here. Binding.

#### Slice 3 — store and crypto

- **Module surface, ratified as RED proposed it.** `src/store/index.ts` exports `class ChatStore` with `static open(paths: DgPaths, seams?: {env?, keychain?}): Promise<ChatStore>`, `close()`, `userVersion()`, `cryptoMeta()`, `insertMessage({sessionId,id,role,body})`, `insertCommandInvocation({sessionId,id,argv,stdout,stderr,truncated})`, `claimNext(sessionId)`, `ack(sessionId,claimId)`, `peekAll(sessionId)`. `src/store/migrations.ts` exports `MigrationStep{version,run}`, `runMigrations(db,steps,{snapshotDir}?)`, `ForwardOnlyVersionError`. `src/crypto/envelope.ts` exports `createCipherBox(dataKey, seams?:{randomIv?}).{encryptRecord(plaintext,aad),decryptRecord(ciphertext,iv,tag,aad)}` and `buildAad({domain,sessionId,rowId,formatVersion})`. `src/crypto/key-file.ts` exports `mintFallbackKeyFile(keyPath,kek,keyId)` and `readFallbackKeyFile(keyPath)`. `src/crypto/key-resolution.ts` exports `fingerprintKey`, `wrapDataKey`/`unwrapDataKey`, `resolveDataKey({existing,keyPath,mode,keychain})`, `KeyResolutionRefusedError{recordedSource,recordedKeyId,candidates}`, `KeychainBackend{lookup,store}`. The `randomIv` seam is a test seam, not an IV parameter on the public surface — `encryptRecord` still generates its own 12 bytes, and the spec's prohibition stands.
- **Claim redelivery is a TIME-BOUNDED lease, not restart-only** — this OVERRIDES RED's recommendation. RED proposed resetting in-flight claims only when `ChatStore` reopens. That loses messages in the ordinary case: slice 7's `recv` is a short-lived CLI process, so if it claims a message and dies, the long-lived daemon never restarts (its idle-TTL requires zero sessions AND zero connections) and the human's message is stranded indefinitely — contradicting Scope's "claim-lease read semantics so a non-listening agent misses nothing". The word is *lease*, and `claimed_at` exists in the required schema for exactly this. `claimNext` reclaims any row whose `claim_id` is set and whose `claimed_at` is older than the lease, **inside the same single UPDATE … RETURNING** — so this adds no fourth verb and no change to the ratified API. Lease duration takes a `DG_CLAIM_LEASE_MS` seam, per the `DG_`-prefixed convention. Resetting in-flight claims on reopen is kept as well; it is free and covers the crash case.
- **A wrong-mode state directory self-heals, but audibly.** `chmod` to 0700 and log a warning naming the prior mode. The spec's wording difference is deliberate — "assert its mode" for the daemon-owned directory versus "refused" for the key file, which another process could have planted — but a silent `chmod` would hide that the 0644 database and `-wal` files had been group- or world-readable. The contents are encrypted, so continuing is defensible; losing the signal is not.
- **`DG_KEY_SOURCE` gates PROBING, not just fresh-mint source choice** — confirmed as RED proposed. `DG_KEY_SOURCE=file` must not probe the keychain even when `crypto_meta.key_source` records `keychain`. Its documented purpose is test isolation ("the suite must never read or write the developer's real login keyring"), and it also lets an operator sidestep the macOS `security` GUI-ACL prompt hazard under a detached daemon. When the gated source cannot match the recorded `key_id`, resolution REFUSES TO START — that is the correct outcome, not a regression: an honest refusal is exactly what identity-first resolution exists to produce, versus silently minting a second key.

#### Slice 5 — extension chat client

- **Module surfaces, ratified as RED proposed them.** `createChatClient` with `connect(bootstrap)` (opens the shared socket on first call, accumulates further session capabilities on later calls — no separate `addCapability`), `onFrame(listener)` as a single demuxed subscription that never fires for a sessionId outside the capability set, `sendUserMessage(sessionId, body, opts?)` returning the messageId and throwing for an uncaptured sessionId, `getConnectionState()`, and `ChatClientOptions = {openSocket?, backoffBaseMs?, backoffMaxMs?, randomJitter?}`. `createChatSessions` with `applyFrame(frame)`/`list()`/`get(sessionId)`/`markSessionRead(sessionId)`. `createTranscriptView` with `appendUserMessage`/`appendAgentMessage(frame, token)`/`updateProgress(state)`/`applyHistory(messages)` and an injectable `fetchAsset(assetId, sessionId, token)` seam returning `{status:"ok",blobUrl}` | `{status:"removed"}` | `{status:"error"}` — the three-way result is what makes a pruned asset distinguishable from a load failure, as the plan requires.
- **A session's status defaults to `"unknown"`, typed `ProgressState | "unknown"`.** RED's reasoning is right and worth keeping: defaulting to `running` in the absence of a progress frame would itself be inferring live state from silence, which the plan explicitly forbids. A progress or agent-message frame for a sessionId with no roster entry is ignored rather than fabricating a partial one.
- **Slice 5 MAY edit `pkg/extension/lib/background/chat.ts`** so `registerChat` delegates its socket handling to `createChatClient`. There must be exactly ONE socket implementation: the background owns the socket so background chats keep receiving while the tab is closed, and a second client-side socket would break that. Safe in this layer because slice 3, its only parallel sibling, is `pkg/dg-server`-only.

#### Cross-slice: `history-response` item shape

Settled now rather than deferred, so slice 3 builds to it and slice 5's tests do not need reworking
later. `history-response.messages[]` items are the **stored-record projection, not wire frames**:
`{ seq: number, id: string, role: "user" | "agent", body: string, createdAt: string, attachmentId?: string }`,
ordered by `seq` ascending. Keying on `role` rather than a frame `type` follows the schema, where
`role` is one of the plaintext indexable columns, and keeps stored records distinct from the frame
union. `seq` is the ordering key because timestamps are neither unique nor monotonic.

### Encryption write-paths owned by later slices (execute-mode)

Slice 3 encrypted every field it has a write-path for and flagged the rest rather than inventing
uncalled API. Accepted — the alternative was adding `insertAsset`/`insertStatusEvent`/
`persistManifest` to a just-ratified `ChatStore` surface with no caller and no coverage.

**Done in slice 3:** message bodies and `command_invocations` argv/stdout/stderr, with distinct AAD
domains (`message-body`, `command-argv`, `command-stdout`, `command-stderr`), all covered by the
on-disk byte-scan tests.

**Owed by later slices**, each of which must EXTEND `ChatStore` with its own write-path and encrypt
through slice 3's exported `createCipherBox`/`buildAad` rather than hand-rolling a second cipher:

- **Slice 7** — `status_events` progress text. Its own AAD domain tag.
- **Slice 8** — the persisted command manifest. Its own AAD domain tag.
- **Slice 9** — asset bytes and asset display filenames. A distinct AAD domain tag for each.

The `assets` and `status_events` tables already carry the correct ciphertext/iv/tag column shapes, so
these are write-path additions, not migrations. The slice-3 Engineering bullet covering all of them
stays UNCHECKED until slice 9 closes the last one — it is a real obligation, not a documentation
nicety, and the final review should treat an unencrypted asset filename as a defect.

### Known limitation — unstructured error frames (deferred to bundle 2)

The `error` frame carries free text and no structured code, so a client cannot tell a **fatal**
rejection ("this capability is dead, stop retrying") from a **benign** per-request one ("that verb
lands in slice 8"). Slice 5's reconnect logic therefore cannot correctly give up against a daemon
that has forgotten the session entirely.

Not fixed here, deliberately. Nothing in the plan requires a client to give up — slice 5's
Engineering asks for jittered backoff and `instanceId`-matched rediscovery, both of which are built —
and adding a code enum is a cross-slice protocol change to `@dg/common`, the daemon and the client
with no spec mandate behind it. The realistic symptoms ARE fixed: keepalives are gated on a
confirmed `session-list`, and a `session-closed` frame prunes that session so its dead token never
burns the shared socket's failed-frame budget. What remains is the narrow case of a daemon restart
that leaves a stale capability with no `session-closed` to observe.

Bundle 2 should add an optional `code` to the error frame. Reacting to the current free-text message
would mean string-matching daemon-controlled text, which is worse than the gap.

### Slice 3 — sqlite-store-and-encryption

The encrypted store, and the only store of record. `bun:sqlite` in WAL with `STRICT` tables and
hand-rolled `PRAGMA user_version` migrations, plus AES-GCM envelope encryption over a random
per-database data key wrapped by a keychain or file KEK. Key resolution is identity-first: it refuses
to start on a fingerprint mismatch rather than minting a second key and orphaning the transcript, and
each of the four sources distinguishes *unreachable* from *absent* — which matters because
`secret-tool` exits 1 both when a secret is absent and when the session bus is down while the secret
exists.

Three empirical findings shaped the implementation rather than staying as notes. A *consistently*
wrong-length IV round-trips fine through GCM, whose auth tag only catches a mismatch between encrypt
and decrypt — so the 12-byte assertion is an explicit check, not something the tag provides. WAL
holds plaintext in the `-wal` sidecar before checkpoint, so the byte-scan test reads that file while
the store is still open. And `PRAGMA foreign_keys`/`busy_timeout` are per-connection and reset on
every fresh `Database`, so a test asserting them through a separate raw connection could never pass
for any implementation; the suite drives the real setup function instead.

One incident worth recording: an early test run wrote a real key into the developer's live login
keyring, because wiring `ChatStore.open()` into the daemon's startup path made every
subprocess-driven test inherit `DG_KEY_SOURCE=auto`. Fixed at the shared harness level and the entry
removed. Verified absent.

Verified: `pkg/dg-server` 96 pass / 1 todo / 0 fail, lint clean, binary compiles.

### Slice 5 — extension-chat-client

One socket, session state, and the transcript renderer. Transcript content renders through
`textContent` only — it is untrusted agent and user text, and an `innerHTML` path would hand it
extension-page script privileges including the session token and `$` dispatch.

This slice needed a full rework pass. Its first attempt added a SECOND socket engine instead of
delegating to `createChatClient` as ratified, which QA proved by building the extension and finding
none of the three new modules in the bundle at all — they were reachable only from their own tests.
Three CRITICALs followed from that one root cause: the background socket registered no `message`
listener so it discarded every inbound frame; an unbounded reconnect loop dropped `instanceId`
matching and would latch onto an unrelated fresh daemon, spamming dead-token keepalives until it
earned a 1008 close, forever; and `connect()`'s `if (socket)` guard went false after a synchronous
open throw, so a queued message could be flushed twice across two live sockets — reproduced, and a
direct violation of the exactly-once criterion.

All fixed, with the delegation verified by wire-protocol literals present in the built bundle rather
than by identifier names, which minification mangles. A further HIGH surfaced from the corrected
architecture itself: with one socket shared across sessions, a `session-closed` frame has to prune
that session's keepalive bookkeeping, or its invalidated token keeps spending a failed-frame budget
that force-closes the socket for every session still open.

Verified: `pkg/extension` 456 pass / 0 fail, lint clean, build clean.

### Layer-3 ratifications (execute-mode, pre-proxy)

Settled before slices 6 and 7 were handed to the `codex` backend, so an external agent builds one
contract rather than inventing its own. Binding.

#### Slice 6 — chat page

- **Module surfaces, ratified as RED proposed and pinned by its tests.** `chat-node.ts` exports `createComposer(container, onSubmit) -> { inputElement }` (Enter submits the trimmed body and clears; empty/whitespace is a no-op) — **this IS the ratified composer mount seam**, one exported hook plus the input element, and slice 8 attaches autocomplete listeners directly to `inputElement`. Plus `createChatNode(entry, options?) -> { element, transcript, composer, render(entry), destroy() }` where `element` carries class `chat-node`, `render()` updates in place rather than replacing the node, and a `[data-status]` element holds the label as `textContent` with the raw status in the attribute; `statusLabel(status)` mapping `running -> "RUNNING"`, `awaiting-input -> "NEEDS YOU"`, `agent-gone`, `unknown`; and `groupSessionsByWorkset(sessions)` returning sections in first-seen workset order, orchestrator sorted first within each, and a single trailing `{workset: undefined}` group placed last regardless of when its sessions were first seen. `entrypoints/chat/main.ts` exports `ChatPageOptions` and `renderChatPage(options?)`, with module-scope auto-invocation guarded on `typeof document !== "undefined"` so importing it under `bun:test` never throws.
- **The spatial-repositioning block in slice 6's Engineering checklist is carryover from slice 11 and does NOT apply.** Arrow-nudge, Shift-jump, roving tabindex, pan-to-focused-node and the aria-grabbed discussion all presuppose x/y coordinates; the grouped rail beat the canvas precisely because it is linear and non-spatial. The bound Testing Criterion — "repositioning is achievable with a single pointer without dragging" — is satisfied as **list reorder**: a per-row Move button arms move mode, ArrowUp/ArrowDown swap the row among its siblings, Enter commits, Escape restores the original order, and a plain click on another row places it there. Do NOT invent coordinates the settled layout has no use for.
- **The open chat tab does NOT open its own socket. The background relays frames to it.** RED correctly surfaced this as an unresolved architectural choice, but a standing ratification already decides it: Code Structure's marker decision gives the background ownership of the WebSocket, and `### Layer-2 module surface ratifications` requires exactly one socket — "a second client-side socket would break that". So `registerChat`'s `onFrame` relays every frame to open chat tabs over `lib/chat-messages.ts`'s `MSG` (the `dg-chat:` prefixed IPC that already exists for the marker relay), outbound sends travel the same path in reverse, and the page's `createClient` wraps that relay behind the same `ChatClient` interface its tests already inject. **Slice 6 may therefore edit `pkg/extension/lib/background/chat.ts`** to add the relay. The cost is a message hop; the alternative is two live sockets per session, each holding the token, with the background's doing nothing useful whenever the tab is open.

#### Slice 7 — agent-facing CLI

- **[CRITICAL, and it is slice 7's job] `handleUserMessage` must persist to the store.** It does not today — its own source comment defers persistence to "slice 7/8's dispatch wiring", and RED confirmed empirically that after a page sends a `user-message`, `claimNext` returns nothing. Without this the entire `recv` path is inert. Slice 7 wires `store.insertMessage` there and **may edit `src/server/frame-handlers.ts`** to do it.
- **CLI-native messages are a `cli-*` family over `/cli` only, outside the 18 ratified discriminants.** Ratified as RED proposed: `{type:"cli-recv",block,timeoutMs}` answered by `{type:"cli-recv-result",outcome:"delivered"|"empty"|"timeout"|"closed",message?}`, plus `{type:"cli-ack",claimId}`, `{type:"cli-send",body}`, `{type:"cli-progress",state}`, `{type:"cli-manifest-publish",commands}`. They are checked structurally BEFORE `validateChatFrame`, exactly like the existing `connect` carve-out, and trusted via the `/cli` connection's already-proven capability rather than a per-frame token — which is necessary, because `agent-message`, `progress` and `manifest-publish` are structurally outbound-only and a CLI-authored instance could never pass `authorizeFrame`. The daemon relays them onward to `/ws` holders as the REAL ratified frame types, so the page-facing wire is unchanged. Slice 1's Engineering already carves out "the `/cli` route's pre-session frames" for this. Slice 7 **may edit `src/server/frame-handlers.ts`** and **`src/index.ts`** — the verbs have to register with commander somewhere reachable, and no later slice claims either file.
- **Verbs, flags and exit codes, ratified as RED proposed.** `recv --session <id> [--block] [--timeout <ms>]`, `send --session <id> <body>`, **`progress`** `--session <id> --state <running|awaiting-input>`, `spawn --session <id> [--workset <label>] [--orchestrator]`, `stage <path> --session <id>`, `close --session <id>`, `manifest --session <id> --commands <path> [--subagents <path>]`, and a global `--session` honored by every verb, omitted to resolve by cwd. The verb is `progress`, NOT `status`: `status` is already slice 2's daemon-status report and the ratified discriminant is `progress`. `EXIT_RECV_TIMEOUT = 5` and `EXIT_RECV_SESSION_CLOSED = 6`, the next free values after `EXIT_PROTOCOL_MISMATCH = 4`.
- **`session-create` gains an optional `agentIdentity`.** RED found no way for a spawned session to carry a distinct agent identity — the ratified frame has only token/role/workset and `handleSessionCreate` always inherits from the requester. But Scope's headline is that an agent "can spawn additional background chats **bound to different agents**", so the field is required, not optional scope. Add it to `@dg/common` as an optional field (additive, so no existing caller breaks); `handleSessionCreate` uses it when present and inherits when absent. **Slice 7 may edit `pkg/common/src/chat-format.ts`** for exactly this.
- **`stage` writes the file; slice 9 writes the `assets` row.** RED was right to scope its test to the filesystem contract. The `assets` table requires an encrypted filename, and `### Encryption write-paths owned by later slices` already assigns asset bytes and filenames to slice 9, which owns `src/assets/**` and asset serving. So slice 7's `stage` resolves the assets dir, writes the bytes and prints an id; **slice 9 owes the `assets`-row write-path plus encryption**, and the slice-7 Engineering bullet "stage registers an asset row" stays UNCHECKED until slice 9 closes it. A staged asset is unretrievable until then, which is fine — retrieval is slice 9's too.
- **Manifest loading, ratified as RED proposed**, with the denylist made concrete. `loadManifestFile(path)` reads, parses and validates, throwing on the first invalid entry with its path in the message; `resolveManifestForPublish(entries)` resolves `argv[0]` via `Bun.which` and refuses an unresolved binary. It also refuses one whose resolved basename is any of: `sh`, `bash`, `dash`, `zsh`, `ksh`, `csh`, `tcsh`, `fish`, `cmd`, `cmd.exe`, `powershell`, `powershell.exe`, `pwsh`, `pwsh.exe`, `env`, `osascript`, `node`, `bun`, `python`, `python3`, `perl`, `ruby`. The rule behind the list: any binary that accepts a string of code to execute (`-c`, `-e`) defeats the whole point of `argv` being a `string[]` where a placeholder occupies a WHOLE element — `bash -c "<placeholder>"` reintroduces exactly the shell injection that design prevents.

### Layer-3 ratification corrections (execute-mode)

Three of layer 3's QA findings are defects in the ratifications above, not in the implementation.
Corrected here.

- **Manifest validation belongs to the DAEMON, not the CLI.** The earlier bullet put `resolveManifestForPublish` in `src/manifest/load.ts` and said "at publish time" without saying *whose* publish. It was wired only into the CLI's `manifest` action — client-side code the daemon cannot guarantee ran. QA opened a raw `/cli` socket with valid session headers, sent a `cli-manifest-publish` carrying `argv:["bash","-c","{cmd}"]`, and it was **accepted with no error**, which would hand slice 8's `$` dispatch a live `bash -c` entry. Publish time means **the daemon's acceptance of the `cli-manifest-publish` frame**. Both the denylist AND `CHAT_MAX_MANIFEST_BYTES` must be enforced there. Client-side validation stays as a fast local error, but it is not the boundary.
- **The denylist matches a NORMALIZED basename, not a fixed literal set.** A literal list cannot work: on this very box `Bun.which("python3")` resolves through symlinks to `python3.14`, whose basename is not in the list, so `python3 -c "{arg}"` passes the check the rule exists to stop. Match the **un-realpath'd** basename as well as the resolved one, and strip trailing version suffixes (`python3.14` → `python3`, `python3` → `python`) before comparing. The rule stands as written — anything accepting a string of code to execute defeats `argv` being a `string[]` — only the matching is fixed.
- **`spawn` must expose `--agent-identity`.** Adding the optional `agentIdentity` field to `session-create` left it unreachable: the daemon honors it but no CLI flag can send it, so every spawned session silently inherits the requester's identity. Scope's headline is spawning chats "bound to different agents", so the flag is required, not polish.
- **`--subagents` must read and validate, or not exist.** As shipped it only `realpathSync`s the path — contents are never read, validated or sent. `@dg/common` has no subagent-manifest type, but slice 1 already ratified that subagent names validate through the barrel-exported `validateProtoIdentifier`. So a subagent manifest is a list of names checked with that validator; no new contract is needed. Slice 8 consumes it for `@` resolution.

### Deferred to the final polish pass (execute-mode)

Sixteen MEDIUM/LOW findings from slice 6's QA were deliberately not fixed in the correction round, to
keep it focused on the CRITICAL and HIGH set. They are real and should be closed before this bundle
ships — most are prototype-fidelity or accessibility gaps, not cosmetics in the dismissible sense:

- **Accessible names flatten.** The rail row's button nests two adjacent `<span>`s with no separating
  text, so its computed name reads `CLAUDE-JSRUNNING`; the section `<h2>` reads `001_chat_harness2 slices`.
  Heading levels are also flat.
- **Transcript messages carry no author label.** The prototype renders an explicit `orchestrator` /
  `you` label above every message; the implementation conveys the difference only as a left border,
  so a screen-reader user cannot tell who spoke.
- **The Move control is not per-row.** It lives in the chat-node header inside the thread pane, and
  non-selected nodes are `hidden` — so it is reachable for exactly one session, and click-to-place is
  dead code guarded on an event target that never matches.
- **`touch-action: none`** on `.chat-page` disables pinch-zoom page-wide. That bullet is slice 11
  canvas carryover, which the layer-3 ratification voided.
- **The theme toggle is hidden below 44rem**, which at 200% zoom on a 1280px viewport removes the only
  control for the ratified light/dark toggle.
- **The orchestrator row lacks its prototype treatment** — accent identity, panel background, and the
  `└` tree connector on indented agent rows.
- **Attachment `<img>` has no `alt`**, so AT announces the blob URL (WCAG 1.1.1). `URL.createObjectURL`
  is also never revoked.
- **`formatGroupCount` labels a live-agent count as "slices".** This one needs a decision, not just a
  fix: the Worksets ratification gives a session only `workset` and `role`, so **no slice count exists
  in the data model at all**. Either add a field or relabel the header to what it actually counts.

### Layer-4 ratifications (execute-mode)

- **`$` must be the LEADING token; `@` may appear inline.** Slice 8's Engineering asks for this to be
  settled and documented, so it is settled here. A `$` entry *executes* — the whole message is the
  invocation, so allowing it mid-sentence makes "did that run?" depend on parsing prose, and ordinary
  text contains `$` for money. An `@` is a *mention*: the message stays prose that gets routed, which
  is exactly why an unresolved mention passes through untouched rather than failing the message. So a
  leading `$` is a dispatch, a `$` anywhere else is literal text, and an `@` is resolved wherever it
  appears. Autocomplete triggers on a leading `$` and on any `@`.
- **Slice 9 inherits the accent token aliases slice 6 added to `entrypoints/options/style.css`.** They
  restate hex values already in that file and must stay outside the `prefers-color-scheme` gate, or
  the chat page's theme toggle regresses to 1.15:1 accent contrast. The slice-9 Engineering bullet
  already warns that slice 9 owns this file while slice 6 reads it — this is the concrete instance.
- **Slice 9 owes the `assets` row write-path**, including encryption of asset bytes AND display
  filenames through slice 3's exported `createCipherBox`/`buildAad` with a distinct AAD domain tag for
  each. Slice 7's `stage` deliberately writes only the file; the row is slice 9's, and until it lands a
  staged asset is unretrievable. Closing this also closes the slice-7 bullet "stage registers an asset
  row", which stays unchecked until then.
- **Slice 8 owes encryption of the persisted command manifest**, likewise through
  `createCipherBox`/`buildAad` with its own AAD domain tag. Do not hand-roll a second cipher.

### Layer-4 deferral resolutions (execute-mode, post-RED)

Layer 4's RED pass returned 15 deferrals. Four were the human's and were ratified by direct answer;
the rest are resolved here as orchestrator. Every identifier below is pinned by a committed RED spec,
so treat these as the contract, not as suggestions.

**Human-ratified (do not re-raise):**

- **`config-result` becomes the 19th discriminant, in `pkg/common/src/chat-format.ts`.** Shape
  `{ key, value?, error? }`. Slice 9 **may edit `chat-format.ts`** for this one addition and nothing
  else. Chosen over a structural pre-`validateChatFrame` carve-out because a frame the validator does
  not know about is exactly how the unstructured-error-frame gap arose, which is already recorded as a
  known limitation deferred to bundle 2.
- **The options page piggybacks an open chat session's capability for `config-get`/`config-set`.**
  When no session is open, disable the directory field and show the daemon-not-running hint — the same
  disabled state the plan already requires for the load-failure path. Do **not** mint a throwaway
  session via `POST /start`: that would put a session-minting path behind a settings page, on the one
  route that writes a filesystem path.
- **Asset ciphertext carries its envelope in-file: `<12-byte IV><16-byte tag><ciphertext>`**, one file
  at `<assetsDir>/<sessionId>/<id>` with no extension; content type comes from the DB row's decrypted
  filename, never the disk name. No migration, and the envelope stays atomic with the bytes it
  authenticates, so a crash cannot leave the DB and the file disagreeing about which IV decrypts what.
- **Startup orphan-pruning sweeps every asset directory unconditionally at boot.** `SessionRegistry`
  has no persistence across a restart, so nothing on disk at boot can belong to a live session.
  **A future persisted registry invalidates this reading** — that is the trigger to revisit it.

**Orchestrator-resolved:**

- **Slice 9 may edit `pkg/dg-server/src/store/index.ts` and `pkg/dg-server/src/server/http.ts`**,
  resolving its CRITICAL. `store/index.ts` gains `insertAsset`/`getAsset`/`pruneSessionAssets`/
  `encryptAssetBytes`/`decryptAssetBytes`; `http.ts`'s `fetch()` gains the `GET /assets/:id` branch,
  whose route and header names already match slice 5's shipped `defaultFetchAsset` verbatim. Same
  explicit grant slices 5 and 7 received.
- **`getAsset` returns `undefined` for an unknown id AND for a wrong-session id** — one indistinguishable
  answer, so the response cannot be used to probe whether another session's asset exists.
- **`CommandEntry.limits?`** is an additive optional field: `{ timeoutMs?, maxOutputBytes?,
  maxConcurrentPerSession?, maxInvocationsPerMinute? }`, each clamped to a daemon maximum declared
  alongside the `CHAT_MAX_*` constants. An override may lower a bound, never raise it past the clamp.
- **`InsertMessageInput`/`ClaimedMessage`/`PeekedMessage` gain `subagentName?: string`**, mirroring the
  shipped `attachmentId?`. `handleUserMessage` resolves inline `@name` tokens against the session's
  published subagent list *before* calling `store.insertMessage`. Without this the `@` mention criterion
  is unsatisfiable.
- **Slice 8 owns the persisted per-session command-manifest and subagent-list store.** Today
  `cli-manifest-publish` validates and broadcasts but persists nothing, so no lookup surface exists for
  a later `command-invocation` to resolve `commandLabel -> argv`. Persist through `ChatStore`, encrypted
  via `createCipherBox`/`buildAad` with its own AAD domain tag.
- **`attachCommandAutocomplete(inputElement, { getCommands, getSubagents?, onDispatch })
  -> { listElement, destroy }`** is adopted as specified. `listElement` carries `role="listbox"` with
  `aria-activedescendant`. Enter on a `$` match calls `onDispatch` and clears the input **without**
  calling the composer's own `onSubmit`; Enter on an `@` match inserts the resolved name and does not
  dispatch; Escape closes with no side effects.
- **`chat-canvas.ts`'s pure-function surface is adopted as specified** — `Point`, `Viewport`
  (`width`/`height` are the *injected* viewport size in screen px, never read from a rect),
  `clampScale`, `clampPan`, `screenToBoard`, `boardToScreen`, `applyDragDelta`, `isNodeInView`, plus
  `canvasPositionKey(sessionId)`, `saveNodePosition`, and `loadNodePositions(liveSessionIds)`.
  `loadNodePositions` both returns only live sessions' positions **and** removes stored keys outside the
  live list — "pruned on load" is an actual storage mutation, not a filter.
  `createChatCanvas(container, { viewport }) -> { boardElement, chromeElement, viewport() }` stays
  minimal; `chromeElement` is an empty sibling slot, and populating it belongs to whichever later
  integration mounts the canvas.

**Deferred to bundle 2, deliberately:**

- **No `invocationId` correlation id on `command-invocation`/`command-result`.** With 2 concurrent
  invocations per session a client genuinely cannot pair a result to its request; tests assert on
  filtered counts instead. Real gap, but nothing in this bundle renders per-invocation UI, so adding a
  field to a ratified frame is not yet earned. Close it before any per-row spinner is built.
- **`ASSET_DIRECTORY_CONFIG_KEY` (`'assetDirectory'`) stays duplicated** in
  `pkg/dg-server/src/assets/config.ts` and `pkg/extension/lib/config.ts`, agreeing by convention only.
  Hoist it into `@dg/common` beside the `CHAT_MAX_*` constants when a slice next has cause to edit there.

### Test-harness hazard — bun:test timeouts and daemon reaping

Recorded because it corrupted results during layer 4 and cost real time to diagnose. `bun:test`'s
default per-test timeout is **5000 ms**. Any daemon-harness test whose own internal wait budget sits at
or near that value races the framework's timeout; when bun wins, it abandons the test while the
already-started WebSocket or `Bun.spawn` keeps running, and the late settlement corrupts a **different**
test's reported result. A surviving daemon subprocess then spins CPU, which starves and fails unrelated
committed specs.

Rules for any new test under `pkg/dg-server/__tests__/`:

- Pass an explicit `it(name, fn, timeoutMs)` comfortably above the test's own total internal budget
  whenever that budget is >= 3000 ms.
- Track every opened WebSocket in an array and close it unconditionally in `afterEach`.
- After a suite run, assert no `index.ts __serve` process survives. Measured on a clean machine, one
  isolated run of `command-invocation.spec.ts` leaks **zero** daemons — a non-zero count means a test
  abandoned in-flight work, not that the daemon is slow to exit.
