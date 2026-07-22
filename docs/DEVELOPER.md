# Developer Guide

## Repository Layout

```text
pkg/
  common/      @dg/common — shared types + pure functions
  extension/   WXT MV3 browser extension (was extension-src/)
  skills/      AI instruction layer — SKILL.md + references for each skill
  skills-cli/  CLI framework — bun build --compile distributable
  skills-test/ smoke tests — skills reference the right packages, install logic
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

## Branch Protection

PRs to `master` require both `ext-blt` and `skills-blt` to pass.
