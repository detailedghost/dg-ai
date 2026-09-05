# Developer Guide

## Repository Layout

```text
pkg/
  common/      @dg/common — shared types + pure functions
  extension/   WXT MV3 browser extension (was extension-src/)
  dg-daemon/   loopback HTTP+WS chat daemon — bun build --compile distributable
  dg-agent/    agent-facing CLI for the daemon — bun build --compile distributable
  skills-cli/  CLI framework — bun build --compile distributable
  skills-test/ smoke tests — skills reference the right packages, install logic
plugins/dg/
  skills/      AI instruction layer — SKILL.md + references for each skill
               (the canonical tree; both .claude-plugin/plugin.json and
               plugins/dg/.codex-plugin/plugin.json point here)
docs/          Documentation
.github/       CI workflows
```

## Getting Started

```bash
# Clone and install all workspace deps at once
git clone https://github.com/detailedghost/dg-ai
cd dg-ai
bun install        # wires the @dg/* workspace symlinks across every package
```

## Per-Package Commands

### pkg/extension (browser extension)

```bash
cd pkg/extension
bun run dev          # WXT dev server
bun run build        # production build → .output/
bun run lint         # tsc --noEmit
bun test             # unit tests
bun run zip          # build + zip for Chrome
bun run zip:firefox  # build + zip for Firefox
```

### pkg/skills-cli (CLI)

```bash
cd pkg/skills-cli
bun src/index.ts --help          # run locally
bun run lint                     # tsc --noEmit
bun test                         # unit tests
bun run build                    # compile binary to dist/
```

### pkg/dg-daemon (chat daemon)

```bash
cd pkg/dg-daemon
bun src/index.ts --help   # run locally
bun run lint              # tsc --noEmit
bun test                  # daemon, store, dispatch and asset tests
bun run build             # compile binary to dist/dg-daemon
```

The daemon is loopback-only and capability-gated. Its store is encrypted at
rest: the data key comes from the OS keychain when one is available and from a
file-backed key otherwise, so a machine with no keychain still works. On WSL it
needs **mirrored** networking mode — under NAT the Windows-side browser cannot
reach the loopback port, and the daemon exits with code 3 rather than pretending
to be reachable.

The daemon pins the extension's origin the first time it proves itself with a
valid session token, and refuses every other origin after that. Reloading an
unpacked extension from a new path changes its origin, which would otherwise
lock the daemon out for good. Run `dg-daemon origin show` to see what is
pinned and `dg-daemon origin clear` to forget it, so the next connecting
extension can pin again. `/start` also caps how many sessions can be active
at once (`DG_MAX_SESSIONS`, default 256), so a runaway local caller cannot
grow the session directory or the in-memory registry without limit.

`~/.dg` is two independent trees. `daemon/` holds that encrypted `daemon.db`.
`agents/` holds session files, staged assets, and a second database,
`memory.db`, that keeps its records in plain text **on purpose**: FTS5
cannot index ciphertext, which is why an agent's memory lives in a separate
database rather than another table in `daemon.db`. Nothing in it is a
secret the daemon's key protects — it holds an agent's own notes, readable
by whoever owns the home directory.

`src/jobs/` is the scheduled-job engine: `runner.ts` ticks every 30s and hands
each due job to the same `dispatch/` executor a chat session uses, and
`parse.ts` reads the job's stdout as one JSON feed item per line. Job rows and
feed items live under one reserved session id, `__scheduler__`, because
`agent_messages.sender_session_id` needs a real session row and the record AAD
is keyed by session id. An enabled job keeps the daemon alive: the idle
predicate in `jobs/idle.ts` counts enabled jobs alongside sessions and open
connections.

### pkg/dg-agent (agent CLI)

```bash
cd pkg/dg-agent
bun src/index.ts --help   # run locally
bun run lint              # tsc --noEmit
bun test                  # CLI, memory store and agent-to-agent tests
bun run build             # compile binary to dist/dg-agent
```

`dg-agent` depends on `dg-daemon` only in its devDependencies. The chat
commands (`recv`, `send`, `progress`, `spawn`, `stage`, `close`, `manifest`)
need a live daemon on the other end of the loopback socket; `memory` does
not — `MemoryStore` opens `agents/memory.db` directly, so every memory verb
works with nothing else running.

`send --to <identity>` queues a message for another agent identity instead of
the human, in a second table (`agent_messages`) rather than a nullable column
on `messages`, so `messages` keeps meaning exactly what it always meant and
`recv` handing an agent only its own inbound rows holds without a filter to
get wrong. `recv` checks the human queue first, then the agent queue; a
sender's own session can never claim its own outbound message back.

The daemon's housekeeping tick prunes `agent_messages` past
`AGENT_MESSAGE_RETENTION_DAYS`, delivered or not, so a message addressed to an
identity that never appears cannot accumulate. It never prunes `messages`:
those rows are the transcript the canvas renders, and a message the human typed
outlives whether an agent ever collected it.

### pkg/common (shared library)

```bash
cd pkg/common
bun run lint   # tsc --noEmit
bun test       # unit tests
```

### pkg/skills-test (smoke tests)

```bash
cd pkg/skills-test
bun run lint   # tsc --noEmit
bun test       # install logic + skill manifests + CLI smoke
```

## CI Overview

| Workflow | Trigger (paths) | Result |
| --- | --- | --- |
| `ext-blt` | PR: extension, common | required on master |
| `ext-release` | push master: extension | tags `ext-v*` |
| `skills-blt` | PR: skills-cli, common, skills, skills-test | required |
| `skills-release` | push master: skills-cli, common | `skills-v*`, 6 bins |
| `dg-daemon-blt` | PR: dg-daemon, common | required |
| `dg-agent-blt` | PR: dg-agent, dg-daemon, common | required |
| `dg-daemon-release` | push master: dg-daemon, common | `daemon-v*` + `server-v*` alias, 6 bins |
| `dg-agent-release` | push master: dg-agent, common | `agent-v*`, 6 bins |

## Branch Protection

PRs to `master` require `ext-blt`, `skills-blt`, `dg-daemon-blt` and
`dg-agent-blt` to pass.

> **Manual step, post-merge.** A repository admin must add the `dg-daemon-blt`
> check to branch protection. Until that is done the workflow runs but cannot
> block a merge, so a broken daemon build would land silently.

## Four independently versioned artifacts

| Artifact | Version source | Release tag |
| --- | --- | --- |
| `dg-ai-extension` zip | `pkg/extension/package.json` | `ext-v*` |
| `dg-skills` binary | `pkg/skills-cli/package.json` | `skills-v*` |
| `dg-daemon` binary | `pkg/dg-daemon/package.json` | `daemon-v*` |
| `dg-agent` binary | `pkg/dg-agent/package.json` | `agent-v*` |
| skill tree | the repository itself | tracked in `master` |

They move independently on purpose. `dg-skills install` refreshes the extension
zip, `dg-skills`, `dg-daemon` and `dg-agent` in one pass, skipping any that is already
current. A platform with no published binary warns and continues rather than
failing the whole install.

## Cross-package integration checklist

Some criteria no single package's tests can observe, because they need a real
browser and a real daemon at the same time. Run these by hand on WSL in
mirrored mode, or through a browser harness:

- [ ] With the daemon running and the extension loaded, a message typed in the
  chat page reaches a blocked `recv`.
- [ ] An agent reply from `send` renders in that session's node.
- [ ] A `$` command published by `manifest` runs from the composer without
  waking the agent.
- [ ] A file passed to `stage` renders in the transcript from a blob URL.
- [ ] Killing the daemon mid-conversation leaves the page in a
  `daemon-not-running` state, and restarting it recovers without a reload.

These are listed rather than faked as `depends_on` edges: an edge only sequences
work, it does not make a criterion observable.
