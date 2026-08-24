# Developer Guide

## Repository Layout

```text
pkg/
  common/      @dg/common — shared types + pure functions
  extension/   WXT MV3 browser extension (was extension-src/)
  dg-daemon/   loopback HTTP+WS chat daemon — bun build --compile distributable
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
| `dg-daemon-release` | push master: dg-daemon, common | `daemon-v*`, 6 bins |

## Branch Protection

PRs to `master` require `ext-blt`, `skills-blt` and `dg-daemon-blt` to pass.

> **Manual step, post-merge.** A repository admin must add the `dg-daemon-blt`
> check to branch protection. Until that is done the workflow runs but cannot
> block a merge, so a broken daemon build would land silently.

## Four independently versioned artifacts

| Artifact | Version source | Release tag |
| --- | --- | --- |
| `dg-ai-extension` zip | `pkg/extension/package.json` | `ext-v*` |
| `dg-skills` binary | `pkg/skills-cli/package.json` | `skills-v*` |
| `dg-daemon` binary | `pkg/dg-daemon/package.json` | `daemon-v*` |
| skill tree | the repository itself | tracked in `master` |

They move independently on purpose. `dg-skills install` refreshes the extension
zip, `dg-skills` and `dg-daemon` in one pass, skipping any that is already
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
