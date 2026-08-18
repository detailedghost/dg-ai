# Chat Harness — Initial Notes

## Purpose
Give a terminal coding agent a browser chat window to converse with the user through. A new persistent daemon (pkg/dg-server) hosts a loopback HTTP+WebSocket server, an encrypted SQLite store, and a session registry; a new dg-ai-extension page (entrypoints/chat/) is its client, presenting live sessions as chat nodes in the project's brutalist-neon theme, placed spatially on a pan/zoom canvas with a linear view toggle for equivalence. The agent blocks on a timeout-bounded recv, replies with whole messages plus progress frames, can spawn additional background chats bound to different agents, publishes a manifest of $-prefixed local commands the daemon executes itself and @-prefixed subagents it routes back to the model, and stages created assets the daemon serves over the same loopback origin.

## Scope
### Included
- New workspace package pkg/dg-server, compiled to a dg-server binary the same way pkg/skills-cli builds dg-skills
- Single daemon hosting MANY sessions over ONE loopback WebSocket, bound to a fixed default port with a deterministic fallback range plus an unauthenticated GET /health carrying only daemon, protocolVersion and instanceId for rediscovery
- A capability-set authorization model: an authenticated socket accumulates sessionId-to-token capabilities, every inbound frame is validated against the exact pair, and outbound frames never carry a token
- SQLite (bun:sqlite, WAL, PRAGMA user_version migrations) as the ONLY store of record, with claim-lease read semantics so a non-listening agent misses nothing
- AES-GCM envelope encryption: a per-database data key stored wrapped by a keychain or file key-encryption key, with identity-first key resolution that refuses to start on a fingerprint mismatch rather than silently minting a second key
- A session lifecycle with an explicit terminal close that invalidates the token, releases any parked blocking recv, and triggers asset cleanup
- New extension page entrypoints/chat/: chat nodes with transcripts, composers, agent identity, and RUNNING / NEEDS YOU badges on the existing brutalist-neon theme tokens, plus a linear view toggle
- A pan/zoom canvas surface placing those nodes spatially, with keyboard and non-drag pointer repositioning
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
- Any change to how the demo tour, recorder, prototype or tab-grouping features behave, beyond routing the shared toolbar-action listener
- A git worktree and a pull request — this bundle is built directly on master
