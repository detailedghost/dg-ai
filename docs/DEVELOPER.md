# Developer Guide

## Monorepo Layout

```
pkg/
  common/      @dg/common — shared types + pure functions
  extension/   WXT MV3 browser extension (was extension-src/)
  skills/      AI instruction layer — SKILL.md + references for each skill
  skills-cli/  CLI framework — bun build --compile distributable
docs/          Documentation
.github/       CI workflows
```

## Getting Started

```bash
# Clone and install all workspace deps at once
git clone https://github.com/detailedghost/dg-ai
cd dg-ai
bun install        # wires pkg/common symlink into pkg/extension and pkg/skills-cli
```

## Per-Package Dev Commands

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
bun run build                    # compile binaries to dist/
```

### pkg/common (shared library)

```bash
cd pkg/common
bun run lint   # tsc --noEmit
bun test       # unit tests
```

## CI Overview

| Workflow | Trigger | Required |
|---|---|---|
| `ext-blt` | PR: pkg/extension/\*\*, pkg/common/\*\* | ✅ required on master |
| `ext-release` | push master: pkg/extension/\*\* | tags ext-vX.X.X |
| `skills-blt` | PR: pkg/skills-cli/\*\*, pkg/common/\*\* | ✅ required on master |
| `skills-release` | push master: pkg/skills-cli/\*\* | tags skills-vX.X.X; 3 binaries |

## Branch Protection

PRs to `master` require both `ext-blt` and `skills-blt` to pass.
